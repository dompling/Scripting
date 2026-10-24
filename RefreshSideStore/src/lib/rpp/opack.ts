// OPACK: Apple's little-endian binary encoding, used for the pair-record `Info` blob.

import { Bytes, concat, fromUtf8, utf8 } from "../util"

/**
 * What a decoded OPACK value can be. Data is a `Uint8Array`; integers that do not fit a
 * JS number come back as `bigint`; dictionaries are plain objects in wire order.
 */
export type OPackValue = null | boolean | number | bigint | string | Bytes | OPackValue[] | OPackDictionary

export interface OPackDictionary {
  [key: string]: OPackValue
}

const SMALL_INT_MAX = 0x27 // 39 — above this the encoder needs the 0x30 u8 form
const INLINE_MAX = 0x20 // 32 bytes fit behind 0x40+len / 0x70+len
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MASK64 = (1n << 64n) - 1n

function le16(value: number): Bytes {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff])
}

function le32(value: number): Bytes {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
}

function le64(value: bigint): Bytes {
  const out = new Uint8Array(8)
  let rest = value & MASK64
  for (let i = 0; i < 8; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function readU32(bytes: Bytes): number {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
}

function floatBytes(value: number, single: boolean): Bytes {
  const buffer = new ArrayBuffer(single ? 4 : 8)
  const view = new DataView(buffer)
  if (single) view.setFloat32(0, value, true)
  else view.setFloat64(0, value, true)
  return new Uint8Array(buffer)
}

function encodeUnsigned(value: bigint, out: Bytes[]): void {
  if (value <= 0xffn) {
    const small = Number(value)
    if (small > SMALL_INT_MAX) out.push(new Uint8Array([0x30, small]))
    else out.push(new Uint8Array([small + 8]))
  } else if (value <= 0xffffffffn) {
    out.push(new Uint8Array([0x32]), le32(Number(value)))
  } else {
    out.push(new Uint8Array([0x33]), le64(value))
  }
}

function encodeValue(value: OPackValue, out: Bytes[]): void {
  if (value === null || value === undefined) {
    // The reference encoder silently drops a null, which corrupts the stream; refuse instead.
    throw new Error("OPACK: null cannot be encoded")
  }
  if (typeof value === "boolean") {
    out.push(new Uint8Array([value ? 0x01 : 0x02]))
    return
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > MASK64) throw new Error("OPACK: bigint must be an unsigned 64-bit value")
    encodeUnsigned(value, out)
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("OPACK: not a finite number")
    if (Number.isInteger(value)) {
      if (value < 0) throw new Error("OPACK: integers are unsigned")
      if (value > Number.MAX_SAFE_INTEGER) throw new Error("OPACK: use a bigint above 2^53")
      encodeUnsigned(BigInt(value), out)
    } else if (Math.fround(value) === value) {
      out.push(new Uint8Array([0x35]), floatBytes(value, true))
    } else {
      out.push(new Uint8Array([0x36]), floatBytes(value, false))
    }
    return
  }
  if (typeof value === "string") {
    const bytes = utf8(value)
    if (bytes.length > INLINE_MAX) {
      if (bytes.length <= 0xff) out.push(new Uint8Array([0x61, bytes.length]))
      else if (bytes.length <= 0xffff) out.push(new Uint8Array([0x62]), le16(bytes.length))
      else out.push(new Uint8Array([0x63]), le32(bytes.length))
    } else {
      out.push(new Uint8Array([0x40 + bytes.length]))
    }
    out.push(bytes)
    return
  }
  if (value instanceof Uint8Array) {
    if (value.length > INLINE_MAX) {
      if (value.length <= 0xff) out.push(new Uint8Array([0x91, value.length]))
      else if (value.length <= 0xffff) out.push(new Uint8Array([0x92]), le16(value.length))
      else out.push(new Uint8Array([0x93]), le32(value.length))
    } else {
      out.push(new Uint8Array([0x70 + value.length]))
    }
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    out.push(new Uint8Array([value.length < 15 ? 0xd0 + value.length : 0xdf]))
    for (const item of value) encodeValue(item, out)
    if (value.length > 14) out.push(new Uint8Array([0x03]))
    return
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
    out.push(new Uint8Array([keys.length < 15 ? 0xe0 + keys.length : 0xef]))
    for (const key of keys) {
      encodeValue(key, out)
      encodeValue(value[key], out)
    }
    if (keys.length > 14) out.push(new Uint8Array([0x03]))
    return
  }
  throw new Error(`OPACK: cannot encode ${typeof value}`)
}

/** Encode one value. The encoder never emits back-references. */
export function encodeOPack(value: OPackValue): Bytes {
  const out: Bytes[] = []
  encodeValue(value, out)
  return concat(...out)
}

function sameScalar(a: OPackValue, b: OPackValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (typeof a === "bigint" || typeof b === "bigint") return typeof a === typeof b && a === b
  return a === b
}

/**
 * Decoder state. `objects` is the back-reference table: scalars only, in first-seen
 * order, each interned once — collections never take a slot.
 */
class Reader {
  at: number
  objects: OPackValue[]
  bytes: Bytes

  constructor(bytes: Bytes) {
    this.bytes = bytes
    this.at = 0
    this.objects = []
  }

  u8(label: string): number {
    if (this.at >= this.bytes.length) throw new Error(`OPACK: unexpected EOF reading ${label}`)
    return this.bytes[this.at++]
  }

  take(count: number, label: string): Bytes {
    if (this.at + count > this.bytes.length) throw new Error(`OPACK: unexpected EOF reading ${label}`)
    const slice = this.bytes.subarray(this.at, this.at + count)
    this.at += count
    return slice
  }

  remaining(): number {
    return this.bytes.length - this.at
  }

  remember(value: OPackValue): OPackValue {
    if (!this.objects.some(seen => sameScalar(seen, value))) this.objects.push(value)
    return value
  }

  lookup(index: number): OPackValue {
    if (index < 0 || index >= this.objects.length) {
      throw new Error(`OPACK: back-reference ${index} out of range (${this.objects.length} seen)`)
    }
    return this.objects[index]
  }
}

function sizedLength(reader: Reader, tag: number, inlineBase: number, u8Tag: number, u16Tag: number, u32Tag: number, u64Tag: number, kind: string): number {
  if (tag >= inlineBase && tag < u8Tag) return tag - inlineBase
  if (tag === u8Tag) return reader.u8(`${kind} length`)
  if (tag === u16Tag) {
    const b = reader.take(2, `${kind} length`)
    return b[0] | (b[1] << 8)
  }
  if (tag === u32Tag) return readU32(reader.take(4, `${kind} length`))
  if (tag === u64Tag) {
    const b = reader.take(8, `${kind} length`)
    let length = 0n
    for (let i = 7; i >= 0; i--) length = (length << 8n) | BigInt(b[i])
    if (length > MAX_SAFE) throw new Error(`OPACK: ${kind} too large for this runtime: ${length}`)
    return Number(length)
  }
  throw new Error(`OPACK: unsupported ${kind} tag 0x${tag.toString(16)}`)
}

function decodeArray(reader: Reader, count: number | null): OPackValue[] {
  const items: OPackValue[] = []
  if (count === null) {
    while (reader.u8("array terminator") !== 0x03) {
      reader.at--
      items.push(decodeValue(reader))
    }
  } else {
    for (let i = 0; i < count; i++) items.push(decodeValue(reader))
  }
  return items
}

function decodeDictionary(reader: Reader, count: number | null): OPackDictionary {
  const dict: OPackDictionary = {}
  const pair = (): void => {
    const key = decodeValue(reader)
    if (typeof key !== "string") throw new Error("OPACK: dictionary key is not a string")
    dict[key] = decodeValue(reader)
  }
  if (count === null) {
    while (reader.u8("dictionary terminator") !== 0x03) {
      reader.at--
      pair()
    }
  } else {
    for (let i = 0; i < count; i++) pair()
  }
  return dict
}

function decodeValue(reader: Reader): OPackValue {
  const tag = reader.u8("tag")
  if (tag === 0x01) return true
  if (tag === 0x02) return false
  if (tag >= 0x08 && tag <= 0x2f) return tag - 8
  if (tag === 0x30) return reader.remember(reader.u8("u8"))
  if (tag === 0x31) {
    const b = reader.take(2, "u16")
    return reader.remember(b[0] | (b[1] << 8))
  }
  if (tag === 0x32) return reader.remember(readU32(reader.take(4, "u32")))
  if (tag === 0x33) {
    const b = reader.take(8, "u64")
    let value = 0n
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i])
    return reader.remember(value <= MAX_SAFE ? Number(value) : value)
  }
  if (tag === 0x35) {
    const view = new DataView(new Uint8Array(reader.take(4, "f32")).buffer)
    return reader.remember(view.getFloat32(0, true))
  }
  if (tag === 0x36) {
    const view = new DataView(new Uint8Array(reader.take(8, "f64")).buffer)
    return reader.remember(view.getFloat64(0, true))
  }
  if (tag >= 0x40 && tag <= 0x64) {
    const length = sizedLength(reader, tag, 0x40, 0x61, 0x62, 0x63, 0x64, "string")
    return reader.remember(fromUtf8(reader.take(length, "string")))
  }
  if (tag >= 0x70 && tag <= 0x94) {
    const length = sizedLength(reader, tag, 0x70, 0x91, 0x92, 0x93, 0x94, "data")
    return reader.remember(reader.take(length, "data"))
  }
  if (tag >= 0xa0 && tag <= 0xc0) return reader.lookup(tag - 0xa0)
  if (tag >= 0xc1 && tag <= 0xc4) {
    const width = 1 << (tag - 0xc1)
    const b = reader.take(width, "back-reference index")
    let index = 0n
    for (let i = width - 1; i >= 0; i--) index = (index << 8n) | BigInt(b[i])
    return reader.lookup(Number(index))
  }
  if (tag >= 0xd0 && tag <= 0xde) return decodeArray(reader, tag - 0xd0)
  if (tag === 0xdf) return decodeArray(reader, null)
  if (tag >= 0xe0 && tag <= 0xee) return decodeDictionary(reader, tag - 0xe0)
  if (tag === 0xef) return decodeDictionary(reader, null)
  if (tag === 0x03) throw new Error("OPACK: unexpected terminator")
  throw new Error(`OPACK: unsupported tag 0x${tag.toString(16)}`)
}

/** Decode exactly one value; trailing bytes are an error, as in the reference decoder. */
export function decodeOPack(bytes: Bytes): OPackValue {
  const reader = new Reader(bytes)
  const value = decodeValue(reader)
  if (reader.remaining() !== 0) {
    throw new Error(`OPACK: ${reader.remaining()} unexpected trailing byte(s)`)
  }
  return value
}
