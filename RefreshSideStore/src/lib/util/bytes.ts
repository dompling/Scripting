// Byte helpers. Endian-explicit, no DataView sharing surprises.

export type Bytes = Uint8Array

const HEX = "0123456789abcdef"

export function toHex(bytes: Bytes | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ""
  for (let i = 0; i < b.length; i++) {
    out += HEX[b[i] >> 4] + HEX[b[i] & 0x0f]
  }
  return out
}

export function fromHex(hex: string): Bytes {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "")
  if (clean.length % 2 !== 0) throw new Error("fromHex: odd length")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// btoa/atob take a binary string; chunk so a big IPA blob cannot blow the arg limit.
export function toBase64(bytes: Bytes | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  const CHUNK = 0x8000
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode(...b.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function fromBase64(b64: string): Bytes {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** base64url, the alphabet JWK uses: no padding, `-` and `_` instead of `+` and `/`. */
export function toBase64Url(bytes: Bytes): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The inverse. Accepts padded input too, since not every producer strips the `=`. */
export function fromBase64Url(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4))
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text)
}

export function fromUtf8(bytes: Bytes): string {
  return new TextDecoder().decode(bytes)
}

/**
 * A PEM envelope: base64 at 64 columns, the shape openssl writes.
 *
 * Line endings are LF only. Apple's portal takes the CSR as a string and does not care, but a
 * comparison against openssl's own output would, and the trailing newline is part of what openssl
 * emits.
 */
export function pemEncode(label: string, bytes: Bytes): string {
  const wrapped = toBase64(bytes).replace(/(.{64})/g, "$1\n")
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`
}

export function concat(...parts: (Bytes | ArrayBuffer)[]): Bytes {
  let total = 0
  const views = parts.map(p => {
    const v = p instanceof Uint8Array ? p : new Uint8Array(p)
    total += v.length
    return v
  })
  const out = new Uint8Array(total)
  let at = 0
  for (const v of views) {
    out.set(v, at)
    at += v.length
  }
  return out
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function bytesToArrayBuffer(bytes: Bytes): ArrayBuffer {
  // Copy: a subarray view would otherwise carry its whole backing buffer.
  const out = new ArrayBuffer(bytes.length)
  new Uint8Array(out).set(bytes)
  return out
}

// MARK: - integers (big-endian unless stated)

export function u8(value: number): Bytes {
  return new Uint8Array([value & 0xff])
}

export function u16be(value: number): Bytes {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
}

export function u32be(value: number): Bytes {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
}

export function u64be(value: bigint): Bytes {
  const out = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

export function readU16be(bytes: Bytes, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1]
}

export function readU32be(bytes: Bytes, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

export function readU64be(bytes: Bytes, at: number): bigint {
  let out = 0n
  for (let i = 0; i < 8; i++) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}

export function readU32le(bytes: Bytes, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

// MARK: - little-endian writers (AFC and XPC speak LE)

export function u32le(value: number): Bytes {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ])
}

export function u64le(value: bigint): Bytes {
  if (value < 0n) throw new Error("u64le: negative")
  const out = new Uint8Array(8)
  let remaining = value
  for (let i = 0; i < 8; i++) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n) throw new Error("u64le: value does not fit in 64 bits")
  return out
}

export function readU64le(bytes: Bytes, at: number): bigint {
  let out = 0n
  for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}

// MARK: - big integers as big-endian byte strings (SRP / RSA)

export function bytesToBigInt(bytes: Bytes): bigint {
  let out = 0n
  for (let i = 0; i < bytes.length; i++) out = (out << 8n) | BigInt(bytes[i])
  return out
}

export function bigIntToBytes(value: bigint, length?: number): Bytes {
  if (value < 0n) throw new Error("bigIntToBytes: negative")
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = "0" + hex
  let out = fromHex(hex)
  if (length !== undefined) {
    if (out.length > length) throw new Error(`bigIntToBytes: needs ${out.length} > ${length} bytes`)
    if (out.length < length) {
      const padded = new Uint8Array(length)
      padded.set(out, length - out.length)
      out = padded
    }
  }
  return out
}

export function randomBytes(count: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(count))
}
