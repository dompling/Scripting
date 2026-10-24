// RPPairing transport framing: magic("RPPairing") + u16 BE length + JSON, one envelope per frame.

import { Bytes, concat, fromBase64, fromUtf8, readU16be, toBase64, u16be, utf8 } from "../util"

export const RPPAIRING_MAGIC: Bytes = utf8("RPPairing")
export const RPPAIRING_MAGIC_TEXT = "RPPairing"
export const RPPAIRING_HEADER_LEN = 11

/** Who we claim a frame came from. The responder side sends `"device"`. */
export type Origin = "host" | "device"

export interface RPPlainEnvelope {
  message: { plain: { _0: unknown } }
  originatedBy: Origin
  sequenceNumber: number
}

export interface RPEncryptedEnvelope {
  message: { streamEncrypted: { _0: string } }
  originatedBy: Origin
  sequenceNumber: number
}

export type RPEnvelope = RPPlainEnvelope | RPEncryptedEnvelope

/** `magic(9) + u16 BE JSON length + JSON`. */
export function encodeFrame(value: unknown): Bytes {
  const json = utf8(JSON.stringify(value))
  if (json.length > 0xffff) throw new Error(`rppairing: frame is ${json.length} bytes, over the u16 limit`)
  return concat(RPPAIRING_MAGIC, u16be(json.length), json)
}

export function decodeFrame(bytes: Bytes): unknown {
  if (bytes.length < RPPAIRING_HEADER_LEN) throw new Error("rppairing: frame shorter than its header")
  for (let i = 0; i < RPPAIRING_MAGIC.length; i++) {
    if (bytes[i] !== RPPAIRING_MAGIC[i]) throw new Error("rppairing: bad magic")
  }
  const length = readU16be(bytes, RPPAIRING_MAGIC.length)
  if (bytes.length !== RPPAIRING_HEADER_LEN + length) {
    throw new Error(`rppairing: frame says ${length} JSON bytes, buffer holds ${bytes.length - RPPAIRING_HEADER_LEN}`)
  }
  return JSON.parse(fromUtf8(bytes.subarray(RPPAIRING_HEADER_LEN)))
}

export function plainEnvelope(payload: unknown, sequenceNumber: number, originatedBy: Origin): RPPlainEnvelope {
  // `_0` counts as an integer key for the device, but JSON has to spell it as a string.
  return { message: { plain: { _0: payload } }, originatedBy, sequenceNumber }
}

export function encryptedEnvelope(ciphertext: Bytes, sequenceNumber: number, originatedBy: Origin): RPEncryptedEnvelope {
  return { message: { streamEncrypted: { _0: toBase64(ciphertext) } }, originatedBy, sequenceNumber }
}

/**
 * The `recv_plain` rule: unwrap `message.plain._0` when it is there, otherwise hand back
 * the whole message dict — which is how an encrypted reply arrives.
 */
export function unwrapReceived(value: unknown): unknown {
  const envelope = value as { message?: { plain?: Record<string, unknown> } } | null
  const plain = envelope?.message?.plain
  if (plain && Object.prototype.hasOwnProperty.call(plain, "_0")) return plain._0
  return value
}

/** The ciphertext from a `streamEncrypted` envelope, or null when it is a plain one. */
export function encryptedPayload(value: unknown): Bytes | null {
  const envelope = value as { message?: { streamEncrypted?: { _0?: unknown } } } | null
  const encrypted = envelope?.message?.streamEncrypted
  if (!encrypted || typeof encrypted._0 !== "string") return null
  return fromBase64(encrypted._0)
}

/** Buffers a TCP byte stream and hands back whole envelopes as they complete. */
export class RPFrameReader {
  private buffer: Bytes

  constructor() {
    this.buffer = new Uint8Array(0)
  }

  push(chunk: Bytes): void {
    this.buffer = concat(this.buffer, chunk)
  }

  /** Bytes held back waiting for the rest of a frame. */
  get buffered(): number {
    return this.buffer.length
  }

  /** The next complete envelope, or null when the buffer holds no whole frame yet. */
  tryRead(): unknown | null {
    if (this.buffer.length < RPPAIRING_HEADER_LEN) return null
    for (let i = 0; i < RPPAIRING_MAGIC.length; i++) {
      if (this.buffer[i] !== RPPAIRING_MAGIC[i]) throw new Error("rppairing: bad magic")
    }
    const length = readU16be(this.buffer, RPPAIRING_MAGIC.length)
    if (this.buffer.length < RPPAIRING_HEADER_LEN + length) return null
    const body = this.buffer.subarray(RPPAIRING_HEADER_LEN, RPPAIRING_HEADER_LEN + length)
    this.buffer = this.buffer.subarray(RPPAIRING_HEADER_LEN + length)
    return JSON.parse(fromUtf8(body))
  }

  /** Everything currently complete — two frames in one read give two envelopes. */
  readAll(): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const value = this.tryRead()
      if (value === null) return out
      out.push(value)
    }
  }
}

/** One direction's send counter: starts at 0, increments per frame, never validates inbound. */
export class RPChannel {
  readonly originatedBy: Origin
  private next: number

  constructor(originatedBy: Origin) {
    this.originatedBy = originatedBy
    this.next = 0
  }

  get sequenceNumber(): number {
    return this.next
  }

  plain(payload: unknown): Bytes {
    return encodeFrame(plainEnvelope(payload, this.next++, this.originatedBy))
  }

  encrypted(ciphertext: Bytes): Bytes {
    return encodeFrame(encryptedEnvelope(ciphertext, this.next++, this.originatedBy))
  }
}
