// Apple's binary XPC body format, the 24-byte XPC wrapper, and the RSD HTTP/2 handshake.

import { type Bytes, concat, utf8 } from "../util"
import { PlistReal, PlistUid, type PlistValue } from "../util"

export const XPC_BODY_MAGIC = 0x42133742
export const XPC_BODY_VERSION = 5
export const XPC_WRAPPER_MAGIC = 0x29b00b92
export const XPC_WRAPPER_LEN = 24

/** Object tags, all little-endian u32s. */
export const XPC_TYPE = {
  null: 0x00001000,
  bool: 0x00002000,
  int64: 0x00003000,
  uint64: 0x00004000,
  double: 0x00005000,
  date: 0x00007000,
  data: 0x00008000,
  string: 0x00009000,
  uuid: 0x0000a000,
  array: 0x0000e000,
  dictionary: 0x0000f000,
  fileTransfer: 0x0001a000,
} as const

export const XPC_FLAG = {
  AlwaysSet: 0x00000001,
  DataFlag: 0x00000100,
  WantingReply: 0x00010000,
  Reply: 0x00020000,
  FileTxStreamRequest: 0x00100000,
  FileTxStreamResponse: 0x00200000,
  InitHandshake: 0x00400000,
} as const

export const ROOT_CHANNEL = 1
export const REPLY_CHANNEL = 3

const MASK64 = (1n << 64n) - 1n

/** An XPC dictionary keeps insertion order, so it is a list of pairs, not an object. */
export type XpcDictionaryEntry = [string, XpcValue]

export type XpcValue =
  | { type: "null" }
  | { type: "bool"; value: boolean }
  | { type: "int64"; value: bigint }
  | { type: "uint64"; value: bigint }
  | { type: "double"; value: number }
  | { type: "date"; value: bigint }
  | { type: "data"; value: Bytes }
  | { type: "string"; value: string }
  | { type: "uuid"; value: Bytes }
  | { type: "array"; value: XpcValue[] }
  | { type: "dictionary"; value: XpcDictionaryEntry[] }
  | { type: "fileTransfer"; msgId: bigint; value: XpcValue }

export const xpcNull: XpcValue = { type: "null" }
export const xpcEmptyDictionary: XpcValue = { type: "dictionary", value: [] }

export function xpcBool(value: boolean): XpcValue {
  return { type: "bool", value }
}

export function xpcInt64(value: bigint): XpcValue {
  return { type: "int64", value }
}

export function xpcUInt64(value: bigint): XpcValue {
  return { type: "uint64", value }
}

export function xpcDouble(value: number): XpcValue {
  return { type: "double", value }
}

export function xpcDate(nanosecondsSinceEpoch: bigint): XpcValue {
  return { type: "date", value: nanosecondsSinceEpoch }
}

export function xpcData(value: Bytes): XpcValue {
  return { type: "data", value }
}

export function xpcString(value: string): XpcValue {
  return { type: "string", value }
}

export function xpcUuid(value: Bytes): XpcValue {
  if (value.length !== 16) throw new Error(`xpc: uuid must be 16 bytes, got ${value.length}`)
  return { type: "uuid", value }
}

export function xpcArray(value: XpcValue[]): XpcValue {
  return { type: "array", value }
}

export function xpcDictionary(value: XpcDictionaryEntry[]): XpcValue {
  return { type: "dictionary", value }
}

export function xpcFileTransfer(msgId: bigint, value: XpcValue): XpcValue {
  return { type: "fileTransfer", msgId, value }
}

/**
 * A plist value as the XPC object the same value would be on the wire.
 *
 * Dictionaries keep their order: the encoder writes entries in the order given, and a device that
 * compares them sees a reordering.
 */
export function xpcFromPlist(value: PlistValue): XpcValue {
  if (value === null) return xpcNull
  if (typeof value === "boolean") return xpcBool(value)
  if (typeof value === "string") return xpcString(value)
  if (typeof value === "bigint") return xpcInt64(value)
  if (typeof value === "number") {
    return Number.isInteger(value) ? xpcInt64(BigInt(value)) : xpcDouble(value)
  }
  if (value instanceof Uint8Array) return xpcData(value)
  if (value instanceof Date) return xpcDate(BigInt(value.getTime()) * 1_000_000n)
  if (value instanceof PlistReal) return xpcDouble(value.value)
  if (value instanceof PlistUid) return xpcUInt64(BigInt(value.value))
  if (Array.isArray(value)) return xpcArray(value.map(xpcFromPlist))
  return xpcDictionary(Object.entries(value).map(([key, entry]) => [key, xpcFromPlist(entry)]))
}

// MARK: - body

function pad(length: number): number {
  return (4 - (length % 4)) % 4
}

function u32le(value: number): Bytes {
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

function zeros(count: number): Bytes {
  return new Uint8Array(count)
}

function encodeObject(value: XpcValue, out: Bytes[]): void {
  switch (value.type) {
    case "null":
      out.push(u32le(XPC_TYPE.null))
      return
    case "bool":
      out.push(u32le(XPC_TYPE.bool), new Uint8Array([value.value ? 1 : 0, 0, 0, 0]))
      return
    case "int64":
      out.push(u32le(XPC_TYPE.int64), le64(value.value))
      return
    case "uint64":
      out.push(u32le(XPC_TYPE.uint64), le64(value.value))
      return
    case "double": {
      const buffer = new ArrayBuffer(8)
      new DataView(buffer).setFloat64(0, value.value, true)
      out.push(u32le(XPC_TYPE.double), new Uint8Array(buffer))
      return
    }
    case "date":
      out.push(u32le(XPC_TYPE.date), le64(value.value))
      return
    case "data":
      out.push(u32le(XPC_TYPE.data), u32le(value.value.length), value.value, zeros(pad(value.value.length)))
      return
    case "string": {
      const bytes = utf8(value.value)
      const length = bytes.length + 1 // the trailing NUL counts in the declared length
      out.push(u32le(XPC_TYPE.string), u32le(length), bytes, zeros(1 + pad(length)))
      return
    }
    case "uuid":
      out.push(u32le(XPC_TYPE.uuid), value.value)
      return
    case "array": {
      const content: Bytes[] = [u32le(value.value.length)]
      for (const item of value.value) encodeObject(item, content)
      const body = concat(...content)
      out.push(u32le(XPC_TYPE.array), u32le(body.length), body)
      return
    }
    case "dictionary": {
      const content: Bytes[] = [u32le(value.value.length)]
      for (const entry of value.value) {
        const bytes = utf8(entry[0])
        content.push(bytes, zeros(1 + pad(bytes.length + 1)))
        encodeObject(entry[1], content)
      }
      const body = concat(...content)
      out.push(u32le(XPC_TYPE.dictionary), u32le(body.length), body)
      return
    }
    case "fileTransfer":
      out.push(u32le(XPC_TYPE.fileTransfer), le64(value.msgId))
      encodeObject(value.value, out)
      return
  }
}

/** `u32 magic + u32 version 5 + one typed object`. */
export function encodeXpcBody(value: XpcValue): Bytes {
  const out: Bytes[] = [u32le(XPC_BODY_MAGIC), u32le(XPC_BODY_VERSION)]
  encodeObject(value, out)
  return concat(...out)
}

class BodyReader {
  at: number
  bytes: Bytes

  constructor(bytes: Bytes) {
    this.bytes = bytes
    this.at = 0
  }

  take(count: number, label: string): Bytes {
    if (this.at + count > this.bytes.length) throw new Error(`xpc: unexpected end of body reading ${label}`)
    const slice = this.bytes.subarray(this.at, this.at + count)
    this.at += count
    return slice
  }

  u32(label: string): number {
    const b = this.take(4, label)
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0
  }

  u64(label: string): bigint {
    const b = this.take(8, label)
    let value = 0n
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i])
    return value
  }

  /** A NUL-terminated string, plus the padding that follows its NUL. */
  cstring(label: string): string {
    let end = this.at
    while (end < this.bytes.length && this.bytes[end] !== 0) end++
    if (end >= this.bytes.length) throw new Error(`xpc: unterminated ${label}`)
    const text = new TextDecoder().decode(this.bytes.subarray(this.at, end))
    const length = end - this.at + 1
    this.at = end + 1 + pad(length)
    return text
  }
}

function decodeObject(reader: BodyReader): XpcValue {
  const tag = reader.u32("object tag")
  switch (tag) {
    case XPC_TYPE.null:
      return xpcNull
    case XPC_TYPE.bool:
      return xpcBool(reader.take(4, "bool")[0] !== 0)
    case XPC_TYPE.int64: {
      const raw = reader.u64("int64")
      return xpcInt64(raw >= 1n << 63n ? raw - (1n << 64n) : raw)
    }
    case XPC_TYPE.uint64:
      return xpcUInt64(reader.u64("uint64"))
    case XPC_TYPE.double: {
      const view = new DataView(new Uint8Array(reader.take(8, "double")).buffer)
      return xpcDouble(view.getFloat64(0, true))
    }
    case XPC_TYPE.date:
      return xpcDate(reader.u64("date"))
    case XPC_TYPE.data: {
      const length = reader.u32("data length")
      const padded = reader.take(length + pad(length), "data")
      return xpcData(padded.subarray(0, length))
    }
    case XPC_TYPE.string: {
      const declared = reader.u32("string length")
      if (declared < 1) throw new Error("xpc: string length must include its NUL")
      const raw = reader.take(declared + pad(declared), "string")
      return xpcString(new TextDecoder().decode(raw.subarray(0, declared - 1)))
    }
    case XPC_TYPE.uuid:
      return xpcUuid(reader.take(16, "uuid"))
    case XPC_TYPE.array: {
      reader.u32("array content length")
      const count = reader.u32("array count")
      const items: XpcValue[] = []
      for (let i = 0; i < count; i++) items.push(decodeObject(reader))
      return xpcArray(items)
    }
    case XPC_TYPE.dictionary: {
      reader.u32("dictionary content length")
      const count = reader.u32("dictionary count")
      const entries: XpcDictionaryEntry[] = []
      for (let i = 0; i < count; i++) entries.push([reader.cstring("dictionary key"), decodeObject(reader)])
      return xpcDictionary(entries)
    }
    case XPC_TYPE.fileTransfer:
      return xpcFileTransfer(reader.u64("file transfer id"), decodeObject(reader))
    default:
      throw new Error(`xpc: unknown object type 0x${tag.toString(16).padStart(8, "0")}`)
  }
}

/** Decode a body, magic and version included. */
export function decodeXpcBody(bytes: Bytes): XpcValue {
  if (bytes.length < 8) throw new Error("xpc: body shorter than its header")
  const reader = new BodyReader(bytes)
  const magic = reader.u32("magic")
  if (magic !== XPC_BODY_MAGIC) throw new Error(`xpc: bad body magic 0x${magic.toString(16)}`)
  const version = reader.u32("version")
  if (version !== XPC_BODY_VERSION) throw new Error(`xpc: unexpected body version ${version}`)
  return decodeObject(reader)
}

// MARK: - the 24-byte wrapper

export interface XpcMessage {
  flags: number
  messageId: bigint
  /** null when the wrapper carries no body. */
  body: Bytes | null
}

/** `magic | flags | u64 body_len | u64 message_id`, then the body when there is one. */
export function encodeXpcMessage(flags: number, body: Bytes | null, messageId: bigint): Bytes {
  const header = concat(
    u32le(XPC_WRAPPER_MAGIC),
    u32le(flags >>> 0),
    le64(body === null ? 0n : BigInt(body.length)),
    le64(messageId),
  )
  return body === null ? header : concat(header, body)
}

/** Decode a wrapper, or null when `bytes` does not hold a whole one yet. */
export function decodeXpcMessage(bytes: Bytes): XpcMessage | null {
  if (bytes.length < XPC_WRAPPER_LEN) return null
  const reader = new BodyReader(bytes)
  const magic = reader.u32("wrapper magic")
  if (magic !== XPC_WRAPPER_MAGIC) throw new Error(`xpc: bad wrapper magic 0x${magic.toString(16)}`)
  const flags = reader.u32("flags")
  const bodyLength = reader.u64("body length")
  const messageId = reader.u64("message id")
  if (BigInt(XPC_WRAPPER_LEN) + bodyLength > BigInt(bytes.length)) return null
  if (bodyLength === 0n) return { flags, messageId, body: null }
  return { flags, messageId, body: bytes.subarray(XPC_WRAPPER_LEN, XPC_WRAPPER_LEN + Number(bodyLength)) }
}

/** The decoded object inside a wrapper, or null for a bodyless one. */
export function decodeXpcMessageBody(message: XpcMessage): XpcValue | null {
  return message.body === null ? null : decodeXpcBody(message.body)
}

// MARK: - HTTP/2 frames

export const HTTP2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"

export type Http2Frame =
  | { type: "data"; streamId: number; payload: Bytes }
  | { type: "headers"; streamId: number }
  | { type: "settings"; streamId: number; flags: number; settings: Array<[number, number]> }
  | { type: "windowUpdate"; streamId: number; increment: number }
  | { type: "rstStream"; streamId: number }
  | { type: "goAway"; lastStreamId: number; debug: string }

function frameHeader(length: number, type: number, flags: number, streamId: number): Bytes {
  return new Uint8Array([
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    type,
    flags,
    (streamId >>> 24) & 0xff,
    (streamId >>> 16) & 0xff,
    (streamId >>> 8) & 0xff,
    streamId & 0xff,
  ])
}

/** SETTINGS: (identifier, value) pairs, 6 big-endian bytes each. */
export function http2SettingsFrame(settings: Array<[number, number]>, streamId = 0, flags = 0): Bytes {
  const body = new Uint8Array(settings.length * 6)
  settings.forEach((entry, index) => {
    const at = index * 6
    body[at] = (entry[0] >>> 8) & 0xff
    body[at + 1] = entry[0] & 0xff
    body[at + 2] = (entry[1] >>> 24) & 0xff
    body[at + 3] = (entry[1] >>> 16) & 0xff
    body[at + 4] = (entry[1] >>> 8) & 0xff
    body[at + 5] = entry[1] & 0xff
  })
  return concat(frameHeader(body.length, 0x04, flags, streamId), body)
}

export function http2WindowUpdateFrame(increment: number, streamId = 0): Bytes {
  const body = new Uint8Array([
    (increment >>> 24) & 0xff,
    (increment >>> 16) & 0xff,
    (increment >>> 8) & 0xff,
    increment & 0xff,
  ])
  return concat(frameHeader(4, 0x08, 0, streamId), body)
}

/** A zero-length HEADERS frame with END_HEADERS — all we need to open a channel. */
export function http2HeadersFrame(streamId: number): Bytes {
  return frameHeader(0, 0x01, 0x04, streamId)
}

export function http2DataFrame(payload: Bytes, streamId: number, endStream = false): Bytes {
  return concat(frameHeader(payload.length, 0x00, endStream ? 0x01 : 0x00, streamId), payload)
}

/** Parse one frame; null while the buffer does not yet hold a complete one. */
export function parseHttp2Frame(bytes: Bytes): { frame: Http2Frame; consumed: number } | null {
  if (bytes.length < 9) return null
  const length = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]
  const type = bytes[3]
  const flags = bytes[4]
  const streamId = ((bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8]) >>> 0
  if (bytes.length < 9 + length) return null
  const body = bytes.subarray(9, 9 + length)
  const consumed = 9 + length

  if (type === 0x00) return { frame: { type: "data", streamId, payload: body }, consumed }
  if (type === 0x01) return { frame: { type: "headers", streamId }, consumed }
  if (type === 0x03) return { frame: { type: "rstStream", streamId }, consumed }
  if (type === 0x04) {
    const settings: Array<[number, number]> = []
    for (let at = 0; at + 6 <= body.length; at += 6) {
      const id = (body[at] << 8) | body[at + 1]
      const value = ((body[at + 2] << 24) | (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5]) >>> 0
      settings.push([id, value])
    }
    return { frame: { type: "settings", streamId, flags, settings }, consumed }
  }
  if (type === 0x07) {
    const lastStreamId = length >= 4 ? ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0 : 0
    const debug = length > 8 ? new TextDecoder().decode(body.subarray(8)) : ""
    return { frame: { type: "goAway", lastStreamId, debug }, consumed }
  }
  if (type === 0x08) {
    if (body.length !== 4) throw new Error("http2: WINDOW_UPDATE body must be 4 bytes")
    const increment = ((body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3]) >>> 0
    return { frame: { type: "windowUpdate", streamId, increment }, consumed }
  }
  throw new Error(`http2: unknown frame type 0x${type.toString(16)}`)
}

// MARK: - the RSD handshake

/**
 * What `RemoteXpcClient::new` + `do_handshake` write, frame for frame: the preface, then
 * SETTINGS, WINDOW_UPDATE, both channels opened, the empty root dictionary and the bare
 * 0x201 message. A fixed byte sequence, so it can be asserted on.
 */
export function rsdHandshakeFrames(): Bytes[] {
  return [
    utf8(HTTP2_PREFACE),
    http2SettingsFrame([[0x03, 100], [0x04, 1048576]]),
    http2WindowUpdateFrame(983041, 0),
    http2HeadersFrame(ROOT_CHANNEL),
    http2DataFrame(encodeXpcMessage(XPC_FLAG.AlwaysSet, encodeXpcBody(xpcEmptyDictionary), 1n), ROOT_CHANNEL),
    http2HeadersFrame(REPLY_CHANNEL),
    http2DataFrame(encodeXpcMessage(XPC_FLAG.InitHandshake | XPC_FLAG.AlwaysSet, null, 1n), REPLY_CHANNEL),
    http2DataFrame(encodeXpcMessage(0x201, null, 1n), ROOT_CHANNEL),
  ]
}

/** The one object that declares us a modern RemoteXPC peer. */
export function deviceHandshakeMessage(uuid: Bytes): XpcValue {
  return xpcDictionary([
    ["MessageType", xpcString("Handshake")],
    ["MessagingProtocolVersion", xpcUInt64(7n)],
    ["UUID", xpcUuid(uuid)],
    [
      "Properties",
      xpcDictionary([
        ["RemoteXPCVersionFlags", xpcUInt64(0x0100000000000006n)],
        ["SensitivePropertiesVisible", xpcBool(true)],
      ]),
    ],
    ["Services", xpcEmptyDictionary],
  ])
}

/** `send_device_handshake`: DataFlag|AlwaysSet on the root channel, message id 1. */
export function deviceHandshakeFrame(uuid: Bytes): Bytes {
  const body = encodeXpcBody(deviceHandshakeMessage(uuid))
  return http2DataFrame(encodeXpcMessage(XPC_FLAG.DataFlag | XPC_FLAG.AlwaysSet, body, 1n), ROOT_CHANNEL)
}
