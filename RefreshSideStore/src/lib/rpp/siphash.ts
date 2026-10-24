// SipHash-2-4 (the reference uses siphasher::sip::SipHasher, not the 1-3 variant).

import { Bytes, fromBase64, toBase64, utf8 } from "../util"

const MASK64 = (1n << 64n) - 1n

function rotl(value: bigint, bits: number): bigint {
  const shift = BigInt(bits)
  return ((value << shift) | (value >> (64n - shift))) & MASK64
}

function readLe64(bytes: Bytes, at: number): bigint {
  let out = 0n
  for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}

function writeLe64(value: bigint): Bytes {
  const out = new Uint8Array(8)
  let rest = value & MASK64
  for (let i = 0; i < 8; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

/**
 * SipHash-2-4 of `message` under a 16-byte key, returned as 8 little-endian bytes.
 * The key is read as two LE u64s: k0 = key[0..8], k1 = key[8..16].
 */
export function siphash24(key: Bytes, message: Bytes): Bytes {
  if (key.length !== 16) throw new Error(`siphash24: key must be 16 bytes, got ${key.length}`)
  const k0 = readLe64(key, 0)
  const k1 = readLe64(key, 8)

  let v0 = (k0 ^ 0x736f6d6570736575n) & MASK64
  let v1 = (k1 ^ 0x646f72616e646f6dn) & MASK64
  let v2 = (k0 ^ 0x6c7967656e657261n) & MASK64
  let v3 = (k1 ^ 0x7465646279746573n) & MASK64

  const sipRound = (): void => {
    v0 = (v0 + v1) & MASK64
    v1 = rotl(v1, 13)
    v1 ^= v0
    v0 = rotl(v0, 32)
    v2 = (v2 + v3) & MASK64
    v3 = rotl(v3, 16)
    v3 ^= v2
    v0 = (v0 + v3) & MASK64
    v3 = rotl(v3, 21)
    v3 ^= v0
    v2 = (v2 + v1) & MASK64
    v1 = rotl(v1, 17)
    v1 ^= v2
    v2 = rotl(v2, 32)
  }

  const whole = message.length - (message.length % 8)
  for (let at = 0; at < whole; at += 8) {
    const block = readLe64(message, at)
    v3 ^= block
    sipRound()
    sipRound()
    v0 ^= block
  }

  // Final block: the remaining bytes little-endian, under the length mod 256 in the top byte.
  let last = BigInt(message.length & 0xff) << 56n
  for (let i = message.length - 1; i >= whole; i--) last |= BigInt(message[i]) << BigInt(8 * (i - whole))
  v3 ^= last
  sipRound()
  sipRound()
  v0 ^= last

  v2 ^= 0xffn
  sipRound()
  sipRound()
  sipRound()
  sipRound()

  return writeLe64(v0 ^ v1 ^ v2 ^ v3)
}

/**
 * The hash as a u64 — the form the published SipHash-2-4 vectors are written in.
 */
export function siphash24U64(key: Bytes, message: Bytes): bigint {
  const le = siphash24(key, message)
  let value = 0n
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(le[i])
  return value
}

/**
 * The 6-byte SipHash-2-4 tag whose base64 goes in a pairable host's `authTag` TXT
 * record: the first 6 bytes of the 8-byte LE hash, reversed.
 */
export function authTagBytes(altIrk: Bytes, identifier: string): Bytes {
  if (altIrk.length !== 16) throw new Error(`authTag: altIrk must be 16 bytes, got ${altIrk.length}`)
  const hash = siphash24(altIrk, utf8(identifier))
  const tag = new Uint8Array(6)
  for (let i = 0; i < 6; i++) tag[i] = hash[5 - i]
  return tag
}

/** `authTagBytes` as the standard padded base64 string the TXT record carries. */
export function authTag(altIrk: Bytes, identifier: string): string {
  return toBase64(authTagBytes(altIrk, identifier))
}

/** Peer-side check: does this base64 tag match the identifier under our alt_irk? */
export function validateAuthTag(altIrk: Bytes, identifier: string, tag: string): boolean {
  if (tag.length !== 8) return false
  const decoded = fromBase64(tag)
  if (decoded.length !== 6) return false
  const expected = authTagBytes(altIrk, identifier)
  let diff = 0
  for (let i = 0; i < 6; i++) diff |= expected[i] ^ decoded[i]
  return diff === 0
}
