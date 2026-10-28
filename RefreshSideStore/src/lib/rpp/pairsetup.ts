// pair-setup as the ACCESSORY (the host side), per RPPairing's TLV exchange.
//
// The device dials us, we show a six-digit PIN, the user types it on the device, and SRP-6a
// proves both sides know it without it ever going over the wire. What comes out is the pairing
// file: the HOST's Ed25519 key pair plus the DEVICE's IRK from the M5 blob.
//
// The transport is abstracted behind `RPPeer`, so the whole exchange can be driven in-process
// for tests — the synthetic device in dev/test-pair.ts implements the same interface.
import type { Bytes } from "../util"
import { concat, fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from "../util"
import { decodeOPack, encodeOPack, type OPackDictionary } from "./opack"
import { decodeTLV, encodeTLV, TLV, tlvU8, tlvU8Value, tlvValue, type TLVEntry } from "./tlv"
import { PS_MSG05, PS_MSG06, chacha20Poly1305Decrypt, chacha20Poly1305Encrypt, messageNonce } from "./aead"
import { pairSetupEncryptKey, pairSetupSignSecret } from "./hkdf"
import { SRP_GROUP_3072, SRPServer, hashWith, type HashFn } from "../util"
import { RPChannel, RPFrameReader } from "./framing"
import type { HostIdentity, PairingFile } from "./pairstore"
import { WIRE_PROTOCOL_VERSION } from "./bonjour"

/** The SRP username. Fixed; it is neither the Apple ID nor anything user-visible. */
export const PAIR_SETUP_USERNAME = "Pair-Setup"

/** The group and hash pair-setup runs over. */
export const PAIR_SETUP_HASH = "SHA-512"

/** B must be exactly this many bytes or the device rejects it. */
export const PAIR_SETUP_B_LENGTH = 384

const KTLV_ERROR_AUTHENTICATION = 0x02

/** What the host tells the device about itself. iOS treats a pairable host as a computer. */
export interface HostDeviceInfo {
  name: string
  model: string
  udid: string
}

export const DEFAULT_HOST_DEVICE_INFO: HostDeviceInfo = {
  name: "SideInstaller",
  model: "Mac17,7",
  udid: "",
}

// MARK: - transport

/**
 * A frame-oriented pipe: `read` hands back a decoded envelope, `write` takes encoded bytes.
 * Decoding lives at the edges so the exchange itself never juggles the wire format.
 */
export interface RPPeer {
  write(bytes: Bytes): Promise<void>
  /** Resolves to null at EOF. */
  read(): Promise<unknown | null>
}

/** The RPPeer implementation used against a real device. */
export class SocketPeer implements RPPeer {
  private readonly reader = new RPFrameReader()
  private readonly chunks: Bytes[] = []
  private wake: (() => void) | null = null
  private closed = false

  constructor(socket: any) {
    const nudge = () => {
      this.wake?.()
      this.wake = null
    }
    socket.on("data", (chunk: any) => {
      this.chunks.push(new Uint8Array(chunk))
      nudge()
    })
    socket.on("close", () => { this.closed = true; nudge() })
    socket.on("error", () => { this.closed = true; nudge() })
    this.socket = socket
  }

  private readonly socket: any

  async write(bytes: Bytes): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (error?: Error) => (error ? reject(error) : resolve()))
    })
  }

  async read(): Promise<unknown | null> {
    for (;;) {
      const ready = this.reader.tryRead()
      if (ready !== null) return ready
      if (this.closed && this.chunks.length === 0) return null
      const chunk = this.chunks.shift()
      if (chunk !== undefined) {
        this.reader.push(chunk)
        continue
      }
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

/** Sends and receives whole frames over a peer, owning one direction's sequence counter. */
export class PeerFrames {
  constructor(
    private readonly peer: RPPeer,
    private readonly label = "pair-setup",
    readonly channel = new RPChannel("device"),
  ) {}

  async send(payload: unknown): Promise<void> {
    await this.peer.write(this.channel.plain(payload))
  }

  async sendEncrypted(ciphertext: Bytes): Promise<void> {
    await this.peer.write(this.channel.encrypted(ciphertext))
  }

  /** The next envelope; throws at EOF, because a peer vanishing mid-exchange is an error. */
  async receive(): Promise<unknown> {
    const value = await this.peer.read()
    if (value === null) throw new Error(`${this.label}: the peer closed the connection`)
    return value
  }
}

// MARK: - envelope shapes

function dig(value: unknown, ...path: string[]): unknown {
  let current: any = value
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    current = current[key]
  }
  return current
}

/** `{"event":{"_0":{"pairingData":{"_0":{data, kind, startNewSession}}}}}` */
export function pairingMessage(tlv: Bytes, startNewSession: boolean): unknown {
  return {
    event: {
      _0: {
        pairingData: {
          _0: { data: toBase64(tlv), kind: "setupManualPairing", startNewSession },
        },
      },
    },
  }
}

/**
 * Pulls the TLV out of a pairing message, tolerating the `_0` wrapping the reference uses.
 * A pairing message arrives inside `message.plain._0`; an encrypted one inside
 * `message.streamEncrypted._0` is a different shape and is not accepted here.
 */
export function pairingDataFrom(value: unknown): { tlv: TLVEntry[], kind: string } {
  const wrapper = (value as any)?.message
  const payload = wrapper?.plain !== undefined ? wrapper.plain._0 : value
  const data = dig(payload, "event", "_0", "pairingData", "_0", "data")
  if (typeof data !== "string") {
    throw new Error("pair-setup: message carried no pairingData")
  }
  return {
    tlv: decodeTLV(fromBase64(data)),
    kind: String(dig(payload, "event", "_0", "pairingData", "_0", "kind") ?? ""),
  }
}

export interface HandshakeResult {
  attemptedPairVerify: boolean
  wireProtocolVersion: number
}

export function parseHandshakeRequest(value: unknown): HandshakeResult {
  const payload = (value as any)?.message?.plain?._0 ?? value
  const handshake = dig(payload, "request", "_0", "handshake", "_0") as any
  if (handshake === undefined || handshake === null) {
    throw new Error("pair-setup: expected a handshake request")
  }
  return {
    attemptedPairVerify: handshake.hostOptions?.attemptPairVerify === true,
    wireProtocolVersion: Number(handshake.wireProtocolVersion ?? 0),
  }
}

/** `allowsPairSetup: true` is what makes the device offer pair-setup to us. */
export function handshakeResponse(info: HostDeviceInfo): unknown {
  return {
    response: {
      forRequestIdentifier: 0,
      _1: {
        handshake: {
          _0: {
            wireProtocolVersion: WIRE_PROTOCOL_VERSION,
            minimumSupportedWireProtocolVersion: 8,
            deviceOptions: {
              allowsPairSetup: true,
              allowsPinlessPairing: false,
              allowsIncomingTunnelConnections: false,
              allowsUpgradeOfLockdownPairings: false,
              allowsSharingSensitiveInfo: false,
            },
            peerDeviceInfo: {
              udid: info.udid,
              deviceKVSIncludesSensitiveInfo: false,
              identifier: "",
              name: info.name,
              model: info.model,
            },
          },
        },
      },
    },
  }
}

// MARK: - the exchange

export interface PairSetupOptions {
  identity: HostIdentity
  /** The host's Ed25519 signing handle, from `PairStore.signingKey`. */
  signingKey: CryptoKey
  /** Called once with the code the user must type on the device. */
  onPin: (pin: string) => void | Promise<void>
  deviceInfo?: HostDeviceInfo
  /** Deterministic salt/PIN for tests; random by default. */
  salt?: Bytes
  pin?: string
  /** Verify the device's M5 signature rather than only parsing it. */
  verifyDeviceSignature?: boolean
}

export interface PairSetupDevice {
  name: string
  model: string
  udid: string
  accountId: string
}

export interface PairSetupResult {
  file: PairingFile
  device: PairSetupDevice
}

export class PairSetupHost {
  private readonly hash: HashFn = hashWith(PAIR_SETUP_HASH)
  private readonly info: HostDeviceInfo

  constructor(private readonly options: PairSetupOptions) {
    this.info = options.deviceInfo ?? DEFAULT_HOST_DEVICE_INFO
  }

  /** Runs the handshake and the whole M1..M6 exchange over one peer. */
  async run(peer: RPPeer): Promise<PairSetupResult> {
    const frames = new PeerFrames(peer)

    // --- handshake -----------------------------------------------------------------
    const handshake = parseHandshakeRequest(await frames.receive())
    if (handshake.attemptedPairVerify) {
      throw new Error(
        "pair-setup: the device asked for pair-verify; only device-initiated pair-setup is supported",
      )
    }
    await frames.send(handshakeResponse(this.info))

    // --- M1: the device opens the SRP exchange --------------------------------------
    const m1 = pairingDataFrom(await frames.receive())
    const m1State = tlvU8Value(m1.tlv, TLV.State)
    if (m1State !== 1) throw new Error(`pair-setup: expected M1 (State=1), got State=${m1State}`)

    // --- M2: our salt and public ephemeral ------------------------------------------
    const salt = this.options.salt ?? randomBytes(16)
    const pin = this.options.pin ?? String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")
    const pinBytes = utf8(pin)
    // The PIN is the SRP password and nothing else. It is never sent; the proof stands in for it.
    await this.options.onPin(pin)

    const srpOptions = {
      group: SRP_GROUP_3072,
      hash: this.hash,
      username: PAIR_SETUP_USERNAME,
      usernameForX: PAIR_SETUP_USERNAME,
      // Pair-setup does not use the textbook SRP proofs; the device uses the `idevice` variant.
      proofStyle: "crate" as const,
    }
    const verifier = SRPServer.computeVerifier(srpOptions, pinBytes, salt)
    const server = new SRPServer(srpOptions, verifier, undefined, PAIR_SETUP_B_LENGTH)
    pinBytes.fill(0)

    await frames.send(pairingMessage(encodeTLV([
      tlvU8(TLV.State, 2),
      { type: TLV.Salt, data: salt },
      { type: TLV.PublicKey, data: server.bPub },
    ]), true))

    // --- M3: the device's proof -----------------------------------------------------
    const m3 = pairingDataFrom(await frames.receive())
    const aPub = tlvValue(m3.tlv, TLV.PublicKey)
    const proof = tlvValue(m3.tlv, TLV.Proof)
    if (aPub === null || proof === null) {
      throw new Error("pair-setup: M3 was missing PublicKey or Proof")
    }

    if (!server.verify(aPub, proof, salt, verifier)) {
      // The reference answers State=4 with kTLVError_Authentication before giving up.
      await frames.send(pairingMessage(encodeTLV([
        tlvU8(TLV.State, 4),
        tlvU8(TLV.ErrorResponse, KTLV_ERROR_AUTHENTICATION),
      ]), false))
      throw new Error("pair-setup: the device's SRP proof did not verify (wrong PIN?)")
    }
    const sessionKey = server.sessionKey!
    const encryptKey = await pairSetupEncryptKey(sessionKey)

    // --- M4: our proof --------------------------------------------------------------
    await frames.send(pairingMessage(encodeTLV([
      tlvU8(TLV.State, 4),
      { type: TLV.Proof, data: server.m2! },
    ]), false))

    // --- M5: the device's identity --------------------------------------------------
    const m5 = pairingDataFrom(await frames.receive())
    const m5Encrypted = tlvValue(m5.tlv, TLV.EncryptedData)
    if (m5Encrypted === null) throw new Error("pair-setup: M5 carried no EncryptedData")

    const m5Entries = decodeTLV(await chacha20Poly1305Decrypt(encryptKey, messageNonce(PS_MSG05), m5Encrypted))
    const deviceIdentifier = tlvValue(m5Entries, TLV.Identifier)
    const deviceLtpk = tlvValue(m5Entries, TLV.PublicKey)
    const deviceSignature = tlvValue(m5Entries, TLV.Signature)
    const deviceInfoBytes = tlvValue(m5Entries, TLV.Info)

    if (deviceIdentifier === null || deviceLtpk === null || deviceInfoBytes === null) {
      throw new Error("pair-setup: M5 was missing Identifier, PublicKey or Info")
    }
    if (deviceLtpk.length !== 32) {
      throw new Error(`pair-setup: M5 PublicKey must be 32 bytes, got ${deviceLtpk.length}`)
    }

    if (this.options.verifyDeviceSignature === true) {
      if (deviceSignature === null) throw new Error("pair-setup: M5 carried no Signature")
      const controllerX = await pairSetupSignSecret(sessionKey, "controller")
      const subtle: any = (globalThis as any).crypto.subtle
      const key = await subtle.importKey("raw", deviceLtpk, { name: "Ed25519" }, false, ["verify"])
      const ok = await subtle.verify(
        { name: "Ed25519" }, key, deviceSignature,
        concat(controllerX, utf8(fromUtf8(deviceIdentifier)), deviceLtpk),
      )
      if (!ok) throw new Error("pair-setup: the device's M5 signature did not verify")
    }

    const device = parseDeviceInfo(decodeOPack(deviceInfoBytes))

    // --- M6: our identity -----------------------------------------------------------
    // Same construction, mirrored: the accessory labels rather than the controller ones.
    const accessoryX = await pairSetupSignSecret(sessionKey, "accessory")
    const subtle: any = (globalThis as any).crypto.subtle
    const hostSignature = new Uint8Array(await subtle.sign(
      { name: "Ed25519" },
      this.options.signingKey,
      concat(accessoryX, utf8(this.options.identity.identifier), this.options.identity.publicKey),
    ))

    const hostInfo: OPackDictionary = {
      altIRK: this.options.identity.altIrk,
      btAddr: "11:22:33:44:55:66",
      mac: new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
      remotepairing_serial_number: "AAAAAAAAAAAA",
      accountID: this.options.identity.identifier,
      remotepairing_udid: this.info.udid,
      model: this.info.model,
      name: this.info.name,
    }

    const m6Encrypted = await chacha20Poly1305Encrypt(encryptKey, messageNonce(PS_MSG06), encodeTLV([
      { type: TLV.Identifier, data: utf8(this.options.identity.identifier) },
      { type: TLV.PublicKey, data: this.options.identity.publicKey },
      { type: TLV.Signature, data: hostSignature },
      { type: TLV.Info, data: encodeOPack(hostInfo) },
    ]))

    // EncryptedData first, then State — that is the order the reference sends.
    await frames.send(pairingMessage(encodeTLV([
      { type: TLV.EncryptedData, data: m6Encrypted },
      tlvU8(TLV.State, 6),
    ]), false))

    return {
      file: {
        publicKey: this.options.identity.publicKey,
        privateKey: this.options.identity.privateKey,
        identifier: this.options.identity.identifier,
        // The M5 blob's altIRK belongs to the DEVICE, and it is what goes into the file.
        deviceAltIrk: device.altIrk,
      },
      device: {
        name: device.name,
        model: device.model,
        udid: device.remotepairing_udid,
        accountId: device.accountID,
      },
    }
  }
}

// MARK: - M5 parsing

export interface DeviceInfo {
  accountID: string
  altIrk: Bytes
  model: string
  name: string
  remotepairing_udid: string
}

/**
 * The fields the device's M5 blob must carry. `altIRK` has to be exactly 16 bytes — the
 * reference refuses anything else, and a wrong length yields a pairing file no device accepts.
 */
export function parseDeviceInfo(value: unknown): DeviceInfo {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error("pair-setup: the device's Info blob was not a dictionary")
  }
  const dict = value as OPackDictionary
  const accountID = dict.accountID
  const altIrk = dict.altIRK
  const model = dict.model
  const name = dict.name
  const udid = dict.remotepairing_udid

  if (typeof accountID !== "string") throw new Error("pair-setup: device Info has no accountID")
  if (!(altIrk instanceof Uint8Array)) throw new Error("pair-setup: device Info has no altIRK")
  if (altIrk.length !== 16) {
    throw new Error(`pair-setup: device altIRK must be 16 bytes, got ${altIrk.length}`)
  }
  if (typeof name !== "string") throw new Error("pair-setup: device Info has no name")
  if (typeof model !== "string") throw new Error("pair-setup: device Info has no model")
  if (typeof udid !== "string") throw new Error("pair-setup: device Info has no remotepairing_udid")

  return { accountID, altIrk, model, name, remotepairing_udid: udid }
}
