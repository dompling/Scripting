// TLV8 as RPPairing speaks it: (type u8, len u8, value), values >255 split into chunks.

import { Bytes, concat } from "../util"

/** The components pair-setup / pair-verify use. Other types pass through untouched. */
export const TLV = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  State: 0x06,
  ErrorResponse: 0x07,
  Signature: 0x0a,
  Info: 0x11,
} as const

export type TLVType = number

export interface TLVEntry {
  type: TLVType
  data: Bytes
}

/** A length byte carries at most 255 bytes; longer values go out as several entries. */
export const TLV_MAX = 255

export function tlvEntry(type: TLVType, data: Bytes): TLVEntry {
  return { type, data }
}

/** A one-byte value, which is all `State` and `Method` ever are. */
export function tlvU8(type: TLVType, value: number): TLVEntry {
  return { type, data: new Uint8Array([value & 0xff]) }
}

/** Encode entries in order, splitting any value longer than 255 bytes. */
export function encodeTLV(entries: TLVEntry[]): Bytes {
  const parts: Bytes[] = []
  for (const entry of entries) {
    if (!Number.isInteger(entry.type) || entry.type < 0 || entry.type > 0xff) {
      throw new Error(`TLV: type out of range: ${entry.type}`)
    }
    if (entry.data.length === 0) {
      parts.push(new Uint8Array([entry.type, 0]))
      continue
    }
    for (let at = 0; at < entry.data.length; at += TLV_MAX) {
      const chunk = entry.data.subarray(at, at + TLV_MAX)
      parts.push(new Uint8Array([entry.type, chunk.length]), chunk)
    }
  }
  return concat(...parts)
}

/**
 * Decode, joining consecutive same-type entries back into one value — the chunking
 * `encodeTLV` does is invisible afterwards. Unknown type bytes are kept as-is.
 */
export function decodeTLV(bytes: Bytes): TLVEntry[] {
  const out: TLVEntry[] = []
  let at = 0
  while (at + 2 <= bytes.length) {
    const type = bytes[at]
    const length = bytes[at + 1]
    at += 2
    if (at + length > bytes.length) throw new Error(`TLV: truncated value at byte ${at - 2}`)
    const data = bytes.subarray(at, at + length)
    at += length
    const previous = out.length > 0 ? out[out.length - 1] : null
    if (previous !== null && previous.type === type) {
      previous.data = concat(previous.data, data)
    } else {
      out.push({ type, data })
    }
  }
  if (at !== bytes.length) throw new Error(`TLV: ${bytes.length - at} trailing byte(s)`)
  return out
}

/** All data of `type`, concatenated — including entries that were not adjacent. */
export function tlvValue(entries: TLVEntry[], type: TLVType): Bytes | null {
  const parts = entries.filter(e => e.type === type).map(e => e.data)
  if (parts.length === 0) return null
  return concat(...parts)
}

export function hasTLV(entries: TLVEntry[], type: TLVType): boolean {
  return entries.some(e => e.type === type)
}

/** The usual one-byte component, e.g. `State`. */
export function tlvU8Value(entries: TLVEntry[], type: TLVType): number | null {
  const value = tlvValue(entries, type)
  if (value === null || value.length === 0) return null
  return value[0]
}
