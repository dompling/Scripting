// The post-pairing encrypted channel, and `createListener`.
//
// After pair-verify, the connection carries ChaCha20-Poly1305-encrypted JSON instead of TLV.
// Two keys, one per direction: we encrypt with `client` and decrypt with `server`. The nonce
// is an 8-byte little-endian counter followed by four zero bytes, and the reply is encrypted
// under the SAME counter value as the request it answers.
//
// `createListener` is how the CDTunnel listener port is obtained. The `key` handed to it is
// the very same raw X25519 secret that becomes the TLS-PSK: the device uses it to authenticate
// the tunnel it is about to open, and sending anything else would produce a listener nothing
// can connect to.
import type { Bytes } from "../util"
import { fromUtf8, toBase64, utf8 } from "../util"
import { decodeTLV } from "./tlv"
import { RPChannel, encryptedPayload } from "./framing"
import { chacha20Poly1305Decrypt, chacha20Poly1305Encrypt, streamNonce } from "./aead"
import { streamKey } from "./hkdf"
import type { RPPeer } from "./pairsetup"

/** The only transport the reference ever asks for. */
export type TransportProtocolType = "tcp"

export interface CreateListenerRequest {
  /** The raw X25519 secret from pair-verify, base64'd. Also the tunnel's PSK. */
  key: Bytes
  transportProtocolType: TransportProtocolType
}

export function createListenerPayload(request: CreateListenerRequest): unknown {
  return {
    request: {
      _0: {
        createListener: {
          key: toBase64(request.key),
          transportProtocolType: request.transportProtocolType,
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

/**
 * The port the device opened, from a `createListener` reply.
 *
 * A refusal arrives as an error object in the same slot, so both shapes are checked and each
 * failure names what it actually found — a silent `undefined` here would surface much later as
 * a tunnel that cannot connect.
 */
export function createListenerPort(reply: unknown): number {
  const response = dig(reply, "response", "_1", "createListener")
  if (response === undefined || response === null) {
    throw new Error(`createListener: reply had no createListener payload (keys: ${Object.keys(reply ?? {}).join(", ")})`)
  }
  const payload = (response as any)._0 ?? response

  const error = (payload as any)?.error
  if (error !== undefined) {
    throw new Error(`createListener: the device refused (${JSON.stringify(error)})`)
  }

  const port = (payload as any)?.port
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`createListener: no usable port in the reply (${JSON.stringify(payload)})`)
  }
  return port
}

/**
 * The encrypted JSON channel that follows pair-verify.
 *
 * One instance owns one counter, because the counter is what the nonce is built from and the
 * device expects the reply under the same value as the request.
 */
export class StreamChannel {
  private readonly clientKey: Bytes
  private readonly serverKey: Bytes
  private counter = 0n

  private constructor(clientKey: Bytes, serverKey: Bytes, private readonly peer: RPPeer, private readonly channel: RPChannel) {
    this.clientKey = clientKey
    this.serverKey = serverKey
  }

  /** Derives both directions from the pair-verify secret. */
  static async connect(sharedSecret: Bytes, peer: RPPeer, channel = new RPChannel("host")): Promise<StreamChannel> {
    if (sharedSecret.length !== 32) {
      throw new Error(`stream: the shared secret must be 32 bytes, got ${sharedSecret.length}`)
    }
    const [clientKey, serverKey] = await Promise.all([
      streamKey(sharedSecret, "client"),
      streamKey(sharedSecret, "server"),
    ])
    return new StreamChannel(clientKey, serverKey, peer, channel)
  }

  private async send(payload: unknown): Promise<void> {
    const nonce = streamNonce(this.counter)
    const ciphertext = await chacha20Poly1305Encrypt(this.clientKey, nonce, utf8(JSON.stringify(payload)))
    await this.peer.write(this.channel.encrypted(ciphertext))
  }

  /**
   * Sends one request and returns the decrypted reply. The counter advances only once a
   * complete exchange has happened, so a reply read under the wrong nonce is a loud failure
   * rather than a silent desynchronisation.
   */
  async request(payload: unknown): Promise<unknown> {
    const nonce = streamNonce(this.counter)
    await this.send(payload)

    const frame = await this.peer.read()
    if (frame === null) throw new Error("stream: the peer closed the connection")
    const ciphertext = encryptedPayload(frame)
    if (ciphertext === null) {
      throw new Error("stream: the reply was not a streamEncrypted envelope")
    }

    const plaintext = await chacha20Poly1305Decrypt(this.serverKey, nonce, ciphertext)
    this.counter += 1n
    return JSON.parse(fromUtf8(plaintext))
  }

  /** Current counter value; the nonce for the next request is built from it. */
  get exchangeCount(): bigint {
    return this.counter
  }

  /**
   * Asks the device to open a CDTunnel listener and returns the port to dial.
   *
   * Pass the same secret that pair-verify produced: it is the tunnel's PSK, and the device
   * uses it to key the listener it is opening.
   */
  async createListener(sharedSecret: Bytes, protocol: TransportProtocolType = "tcp"): Promise<number> {
    const reply = await this.request(createListenerPayload({ key: sharedSecret, transportProtocolType: protocol }))
    return createListenerPort(reply)
  }
}

/** Exposed so a caller can sanity-check a decrypted payload without importing TLV handling. */
export function decodeStreamTlv(bytes: Bytes): ReturnType<typeof decodeTLV> {
  return decodeTLV(bytes)
}
