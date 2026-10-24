// pair-verify as the CLIENT (the host side), dialling the device's remote-pairing port.
//
// The device already has our pairing file, so this is not a trust decision — it is a proof
// that we still hold the Ed25519 key the device recorded, followed by an X25519 exchange.
//
// The deliverable is the raw 32-byte ECDH secret. It is fed verbatim into the TLS-PSK tunnel
// (`VPN.localDevVPN.openRSDTunnel({preSharedKey})`), so it must NOT be run through HKDF — the
// two HKDFs nearby are a different key for the M3 blob and the stream ciphers.
import type { Bytes } from "../util"
import { concat, fromBase64, toBase64, utf8 } from "../util"
import { decodeTLV, encodeTLV, TLV, tlvU8, tlvU8Value, tlvValue } from "./tlv"
import { PV_MSG03, chacha20Poly1305Encrypt, messageNonce } from "./aead"
import { pairVerifyEncryptKey } from "./hkdf"
import type { PairingFile } from "./pairstore"
import { PeerFrames, type RPPeer } from "./pairsetup"

/** The wire protocol version pair-verify is negotiated with. */
export const VERIFY_WIRE_PROTOCOL_VERSION = 19

/** `{"event":{"_0":{"pairingData":{"_0":{data, kind, startNewSession}}}}}` */
export function verifyMessage(tlv: Bytes, startNewSession: boolean): unknown {
  return {
    event: {
      _0: {
        pairingData: {
          _0: { data: toBase64(tlv), kind: "verifyManualPairing", startNewSession },
        },
      },
    },
  }
}

function dig(value: unknown, ...path: string[]): unknown {
  let current: any = value
  for (const key of path) {
    if (current === undefined || current === null) return undefined
    current = current[key]
  }
  return current
}

function payloadOf(value: unknown): unknown {
  return (value as any)?.message?.plain?._0 ?? value
}

function pairingDataOf(value: unknown): { tlv: ReturnType<typeof decodeTLV>, kind: string } {
  const payload = payloadOf(value)
  const data = dig(payload, "event", "_0", "pairingData", "_0", "data")
  if (typeof data !== "string") throw new Error("pair-verify: message carried no pairingData")
  return {
    tlv: decodeTLV(fromBase64(data)),
    kind: String(dig(payload, "event", "_0", "pairingData", "_0", "kind") ?? ""),
  }
}

/** The request that asks the device to run pair-verify with us. */
export function verifyHandshakeRequest(): unknown {
  return {
    request: {
      _0: {
        handshake: {
          _0: {
            hostOptions: { attemptPairVerify: true },
            wireProtocolVersion: VERIFY_WIRE_PROTOCOL_VERSION,
          },
        },
      },
    },
  }
}

export interface VerifyHandshakeResult {
  wireProtocolVersion: number
  minimumSupportedWireProtocolVersion: number
  allowsPairSetup: boolean
}

export function parseVerifyHandshakeResponse(value: unknown): VerifyHandshakeResult {
  const payload = payloadOf(value)
  const handshake = dig(payload, "response", "_1", "handshake", "_0") as any
  if (handshake === undefined || handshake === null) {
    throw new Error("pair-verify: expected a handshake response")
  }
  return {
    wireProtocolVersion: Number(handshake.wireProtocolVersion ?? 0),
    minimumSupportedWireProtocolVersion: Number(handshake.minimumSupportedWireProtocolVersion ?? 0),
    allowsPairSetup: handshake.deviceOptions?.allowsPairSetup === true,
  }
}

export interface PairVerifyOptions {
  file: PairingFile
  /** An Ed25519 signing handle for the pairing file's private key. */
  signingKey: CryptoKey
  /** Deterministic X25519 private key for tests; random by default. */
  ephemeralPrivateKey?: Bytes
}

export interface PairVerifyResult {
  /** The raw X25519 output — the TLS-PSK key, byte for byte. */
  preSharedKey: Bytes
  /** Our ephemeral public key, as sent in M1. */
  hostPublicKey: Bytes
  /** The device's ephemeral public key, from M2. */
  devicePublicKey: Bytes
}

export class PairVerifyClient {
  /** Its own counter, independent of any other channel on the same socket. */
  private readonly frames: PeerFrames

  constructor(private readonly options: PairVerifyOptions, peer: RPPeer) {
    this.frames = new PeerFrames(peer, "pair-verify")
  }

  async run(): Promise<PairVerifyResult> {
    const subtle: any = (globalThis as any).crypto.subtle

    // --- handshake ---------------------------------------------------------------
    await this.frames.send(verifyHandshakeRequest())
    const handshake = parseVerifyHandshakeResponse(await this.frames.receive())
    if (handshake.wireProtocolVersion < VERIFY_WIRE_PROTOCOL_VERSION) {
      throw new Error(
        `pair-verify: the device speaks wire protocol ${handshake.wireProtocolVersion}, ` +
        `which is older than the ${VERIFY_WIRE_PROTOCOL_VERSION} this needs`,
      )
    }

    // --- our ephemeral X25519 key pair --------------------------------------------
    const ephemeral = await generateX25519(this.options.ephemeralPrivateKey)
    const hostPublicKey = ephemeral.publicKey

    // --- M1 ----------------------------------------------------------------------
    await this.frames.send(verifyMessage(encodeTLV([
      tlvU8(TLV.State, 1),
      { type: TLV.PublicKey, data: hostPublicKey },
    ]), true))

    // --- M2 ----------------------------------------------------------------------
    const m2 = pairingDataOf(await this.frames.receive())
    const errorResponse = tlvU8Value(m2.tlv, TLV.ErrorResponse)
    if (errorResponse !== null) {
      // The device will not even start; tell it we are giving up, then fail.
      await this.frames.send({ event: { _0: { pairVerifyFailed: {} } } })
      throw new Error(`pair-verify: the device refused to start (kTLVError ${errorResponse})`)
    }
    const devicePublicKey = tlvValue(m2.tlv, TLV.PublicKey)
    if (devicePublicKey === null || devicePublicKey.length !== 32) {
      throw new Error(`pair-verify: M2 PublicKey must be 32 bytes, got ${devicePublicKey?.length ?? "none"}`)
    }

    // --- the shared secret the tunnel is keyed on ---------------------------------
    const deviceKey = await subtle.importKey("raw", devicePublicKey, { name: "X25519" }, false, [])
    const preSharedKey = new Uint8Array(
      await subtle.deriveBits({ name: "X25519", public: deviceKey }, ephemeral.privateKey, 256),
    )
    if (preSharedKey.length !== 32) {
      throw new Error(`pair-verify: expected a 32-byte shared secret, got ${preSharedKey.length}`)
    }

    // --- M3: our identity, encrypted under that secret -----------------------------
    const subtleSignature = new Uint8Array(await subtle.sign(
      { name: "Ed25519" },
      this.options.signingKey,
      concat(hostPublicKey, utf8(this.options.file.identifier), devicePublicKey),
    ))

    const encryptKey = await pairVerifyEncryptKey(preSharedKey)
    const m3Plain = encodeTLV([
      { type: TLV.Identifier, data: utf8(this.options.file.identifier) },
      { type: TLV.Signature, data: subtleSignature },
    ])
    const m3Encrypted = await chacha20Poly1305Encrypt(encryptKey, messageNonce(PV_MSG03), m3Plain)

    await this.frames.send(verifyMessage(encodeTLV([
      tlvU8(TLV.State, 3),
      { type: TLV.EncryptedData, data: m3Encrypted },
    ]), false))

    // --- M4: the device either accepted or not -------------------------------------
    const m4 = pairingDataOf(await this.frames.receive())
    const failure = tlvU8Value(m4.tlv, TLV.ErrorResponse)
    if (failure !== null) {
      throw new Error(`pair-verify: the device rejected our proof (kTLVError ${failure})`)
    }
    const m4State = tlvU8Value(m4.tlv, TLV.State)
    if (m4State !== null && m4State !== 4) {
      throw new Error(`pair-verify: expected M4 (State=4), got State=${m4State}`)
    }

    return { preSharedKey, hostPublicKey, devicePublicKey: devicePublicKey }
  }
}

interface X25519Pair {
  publicKey: Bytes
  privateKey: CryptoKey
}

/** The fixed 16-byte prefix of an X25519 PKCS#8 private key. */
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

function x25519Pkcs8(seed: Bytes): Bytes {
  return concat(X25519_PKCS8_PREFIX, seed)
}

function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4))
}

/**
 * An X25519 key pair. WebCrypto cannot import a *raw* X25519 private key, but it accepts the
 * same seed wrapped in PKCS#8 — and exporting that key as a JWK hands back both halves (`d`
 * and `x`), which is how the public key is recovered without a scalar-multiply entry point.
 */
export async function generateX25519(privateKeyBytes?: Bytes): Promise<X25519Pair> {
  const subtle: any = (globalThis as any).crypto.subtle
  if (privateKeyBytes === undefined) {
    const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])
    const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey))
    return { publicKey, privateKey: pair.privateKey }
  }
  if (privateKeyBytes.length !== 32) {
    throw new Error(`x25519: private key must be 32 bytes, got ${privateKeyBytes.length}`)
  }
  const privateKey = await subtle.importKey(
    "pkcs8", x25519Pkcs8(privateKeyBytes), { name: "X25519" }, true, ["deriveBits"],
  )
  const jwk: any = await subtle.exportKey("jwk", privateKey)
  if (typeof jwk.x !== "string") {
    throw new Error("x25519: the imported private key exported no public half")
  }
  return { publicKey: fromBase64Url(jwk.x), privateKey }
}
