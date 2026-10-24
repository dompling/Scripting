// Property lists: binary (bplist00) and XML. Apple mixes both across the APIs used here.
import { Bytes, concat, fromBase64, fromUtf8, readU64be, toBase64, u16be, u32be, u64be, utf8 } from "./bytes"

export class PlistUid {
  constructor(readonly value: number) {}
}

/**
 * A plist `<real>` (or the binary `real` type), kept distinct from a number.
 *
 * A plist tells integers and reals apart and a JS number cannot: `1.0` and `1` are the same value,
 * so writing one back as the other silently changes the file. For a document nobody compares byte
 * for byte that is only a formatting question — but it is a change of *value* wherever this project
 * rewrites a plist it did not author, such as an app's `Info.plist` before signing it, or an
 * entitlements dictionary that becomes the DER blob in slot 7.
 *
 * Apple writes the resource-rule weights as `<real>1000</real>`, so a whole-valued real has to come
 * back out as a real for a `CodeResources` to compare byte for byte.
 */
export class PlistReal {
  constructor(readonly value: number) {}
}

/**
 * The number inside a `number` or a `PlistReal`, or null for anything else.
 *
 * Readers that want "the number here" should go through this rather than testing for
 * `typeof === "number"`, which no longer matches a real.
 */
export function plistNumber(value: PlistValue | undefined): number | null {
  if (typeof value === "number") return value
  if (value instanceof PlistReal) return value.value
  return null
}

export type PlistValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | Bytes
  | PlistUid
  | PlistReal
  | PlistValue[]
  | { [key: string]: PlistValue }

export type PlistDict = { [key: string]: PlistValue }

const BPLIST_MAGIC = "bplist00"

// MARK: - dispatch

export function parsePlist(input: Bytes | string): PlistValue {
  if (typeof input === "string") {
    const trimmed = input.trimStart()
    if (trimmed.startsWith(BPLIST_MAGIC)) {
      // latin1 round-trip of a binary plist read as text
      const bytes = new Uint8Array(input.length)
      for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff
      return parseBinary(bytes)
    }
    return parseXml(input)
  }
  const head = fromUtf8(input.subarray(0, Math.min(8, input.length)))
  return head === BPLIST_MAGIC ? parseBinary(input) : parseXml(fromUtf8(input))
}

export function asDict(value: PlistValue): PlistDict {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date || value instanceof Uint8Array || value instanceof PlistUid || value instanceof PlistReal) {
    throw new Error("plist: expected a dictionary")
  }
  return value as PlistDict
}

export function str(dict: PlistDict, key: string): string | undefined {
  const v = dict[key]
  return typeof v === "string" ? v : undefined
}

// MARK: - binary plist

function parseBinary(bytes: Bytes): PlistValue {
  const trailerAt = bytes.length - 32
  const offsetSize = bytes[trailerAt + 6]
  const refSize = bytes[trailerAt + 7]
  const numObjects = Number(readU64be(bytes, trailerAt + 8))
  const topObject = Number(readU64be(bytes, trailerAt + 16))
  const offsetTableAt = Number(readU64be(bytes, trailerAt + 24))

  const offsets: number[] = new Array(numObjects)
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readSized(bytes, offsetTableAt + i * offsetSize, offsetSize)
  }

  const readObject = (index: number): PlistValue => {
    const at = offsets[index]
    if (at === undefined) throw new Error(`bplist: bad object ref ${index}`)
    const marker = bytes[at]
    const kind = marker >> 4
    const extra = marker & 0x0f

    switch (kind) {
      case 0x0:
        if (extra === 0x0) return null
        if (extra === 0x8) return false
        if (extra === 0x9) return true
        return null // fill
      case 0x1: {
        const size = 1 << extra
        // plistlib/CoreFoundation read 8-byte ints as signed and shorter ones as unsigned.
        if (size === 8) {
          const raw = readSizedRaw(bytes, at + 1, size)
          const signed = raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw
          if (signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(signed)
          return signed
        }
        return readSized(bytes, at + 1, size)
      }
      case 0x2: {
        const size = 1 << extra
        const view = new DataView(bytes.buffer, bytes.byteOffset + at + 1, size)
        // Kept as a PlistReal so it round-trips as a real rather than becoming an integer.
        const real = size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false)
        return new PlistReal(real)
      }
      case 0x3:
        return new Date(978307200000 + readDoubleAt(bytes, at + 1) * 1000)
      case 0x4: {
        const { count, headerEnd } = readLength(bytes, extra, at)
        return bytes.slice(headerEnd, headerEnd + count)
      }
      case 0x5: {
        const { count, headerEnd } = readLength(bytes, extra, at)
        return fromUtf8(bytes.subarray(headerEnd, headerEnd + count))
      }
      case 0x6: {
        const { count, headerEnd } = readLength(bytes, extra, at)
        return decodeUtf16be(bytes.subarray(headerEnd, headerEnd + count * 2))
      }
      case 0x8: {
        const size = extra + 1
        return new PlistUid(readSized(bytes, at + 1, size))
      }
      case 0xa:
      case 0xb: {
        const { count, headerEnd } = readLength(bytes, extra, at)
        const out: PlistValue[] = []
        for (let i = 0; i < count; i++) out.push(readObject(readSized(bytes, headerEnd + i * refSize, refSize)))
        return out
      }
      case 0xd: {
        const { count, headerEnd } = readLength(bytes, extra, at)
        const out: PlistDict = {}
        for (let i = 0; i < count; i++) {
          const key = readObject(readSized(bytes, headerEnd + i * refSize, refSize))
          const value = readObject(readSized(bytes, headerEnd + (count + i) * refSize, refSize))
          if (key === null) continue
          out[String(key)] = value
        }
        return out
      }
      default:
        throw new Error(`bplist: unsupported marker 0x${marker.toString(16)} at ${at}`)
    }
  }

  return readObject(topObject)
}

function readLength(bytes: Bytes, extra: number, at: number): { count: number, headerEnd: number } {
  if (extra !== 0x0f) return { count: extra, headerEnd: at + 1 }
  const marker = bytes[at + 1]
  const intSize = 1 << (marker & 0x0f)
  return { count: readSized(bytes, at + 2, intSize), headerEnd: at + 2 + intSize }
}

function readSized(bytes: Bytes, at: number, size: number): number {
  let out = 0
  for (let i = 0; i < size; i++) out = out * 256 + bytes[at + i]
  return out
}

function readSizedRaw(bytes: Bytes, at: number, size: number): bigint {
  let out = 0n
  for (let i = 0; i < size; i++) out = (out << 8n) | BigInt(bytes[at + i])
  return out
}

function readDoubleAt(bytes: Bytes, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0, false)
}

function decodeUtf16be(bytes: Bytes): string {
  let out = ""
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
  return out
}

// A flat, index-addressable form of the value tree: refs are resolved before encoding,
// so the reference width is known by the time any bytes are written.
type EncNode =
  | { t: "null" }
  | { t: "bool", v: boolean }
  | { t: "int", v: number }
  | { t: "bigint", v: bigint }
  | { t: "real", v: number }
  | { t: "date", v: number }
  | { t: "data", v: Bytes }
  | { t: "str", v: string }
  | { t: "uid", v: number }
  | { t: "array", refs: number[] }
  | { t: "dict", keys: number[], vals: number[] }

/** Serialise to a bplist00 buffer. Key order follows insertion order. */
export function writeBinaryPlist(value: PlistValue): Bytes {
  const nodes: EncNode[] = []

  const add = (v: PlistValue): number => {
    nodes.push(toNodePlaceholder())
    const index = nodes.length - 1
    nodes[index] = toNode(v, add)
    return index
  }

  const top = add(value)
  const numObjects = nodes.length
  const refSize = byteWidth(numObjects)
  const objects = nodes.map(node => encodeNode(node, refSize))

  const header = utf8(BPLIST_MAGIC)
  const body = concat(...objects)
  // The offset table's element width must hold the *file's* largest offset, so it is sized
  // from the body length — not from the object count. Sizing it from the count truncates
  // every offset once the file grows past 255 bytes.
  const offsetSize = byteWidth(header.length + body.length)
  const offsets = new Uint8Array(numObjects * offsetSize)
  let cursor = header.length
  for (let i = 0; i < numObjects; i++) {
    writeSized(offsets, i * offsetSize, offsetSize, cursor)
    cursor += objects[i].length
  }

  const trailer = new Uint8Array(32)
  trailer[6] = offsetSize
  trailer[7] = refSize
  trailer.set(u64be(BigInt(numObjects)), 8)
  trailer.set(u64be(BigInt(top)), 16)
  trailer.set(u64be(BigInt(cursor)), 24)

  return concat(header, body, offsets, trailer)
}

function byteWidth(count: number): number {
  return count < 0x100 ? 1 : count < 0x10000 ? 2 : count < 0x1000000 ? 3 : 4
}

function toNodePlaceholder(): EncNode {
  return { t: "null" }
}

function toNode(v: PlistValue, add: (v: PlistValue) => number): EncNode {
  if (v === null) return { t: "null" }
  if (v === true || v === false) return { t: "bool", v }
  if (v instanceof PlistUid) return { t: "uid", v: v.value }
  if (v instanceof PlistReal) return { t: "real", v: v.value }
  if (v instanceof Date) return { t: "date", v: v.getTime() }
  if (v instanceof Uint8Array) return { t: "data", v }
  if (typeof v === "string") return { t: "str", v }
  if (typeof v === "number") return Number.isInteger(v) ? { t: "int", v } : { t: "real", v }
  if (typeof v === "bigint") return { t: "bigint", v }
  if (Array.isArray(v)) return { t: "array", refs: v.map(add) }
  const keys = Object.keys(v)
  return {
    t: "dict",
    keys: keys.map(add),
    vals: keys.map(k => add((v as PlistDict)[k])),
  }
}

function encodeNode(node: EncNode, refSize: number): Bytes {
  switch (node.t) {
    case "null":
      return new Uint8Array([0x00])
    case "bool":
      return new Uint8Array([node.v ? 0x09 : 0x08])
    case "uid": {
      const size = byteWidth(node.v + 1)
      const out = new Uint8Array(1 + size)
      out[0] = 0x80 | (size - 1)
      writeSized(out, 1, size, node.v)
      return out
    }
    case "date": {
      const out = new Uint8Array(9)
      out[0] = 0x33
      new DataView(out.buffer).setFloat64(1, (node.v - 978307200000) / 1000, false)
      return out
    }
    case "data":
      return concat(encodeIntMarker(node.v.length, 0x4), node.v)
    case "str":
      return encodeString(node.v)
    case "int":
    case "bigint":
      return encodeInteger(node.v)
    case "real": {
      const out = new Uint8Array(9)
      out[0] = 0x23
      new DataView(out.buffer).setFloat64(1, node.v, false)
      return out
    }
    case "array":
      return concat(encodeIntMarker(node.refs.length, 0xa), ...node.refs.map(r => refBytes(r, refSize)))
    case "dict":
      return concat(
        encodeIntMarker(node.keys.length, 0xd),
        ...node.keys.map(r => refBytes(r, refSize)),
        ...node.vals.map(r => refBytes(r, refSize)),
      )
  }
}

function encodeString(v: string): Bytes {
  if (/^[\x00-\x7f]*$/.test(v)) {
    const body = new Uint8Array(v.length)
    for (let i = 0; i < v.length; i++) body[i] = v.charCodeAt(i)
    return concat(encodeIntMarker(v.length, 0x5), body)
  }
  const body = new Uint8Array(v.length * 2)
  for (let i = 0; i < v.length; i++) {
    body[i * 2] = v.charCodeAt(i) >> 8
    body[i * 2 + 1] = v.charCodeAt(i) & 0xff
  }
  return concat(encodeIntMarker(v.length, 0x6), body)
}

// Matches plistlib: non-negative values use the smallest unsigned width, negatives always
// take 8 bytes signed. Reading back gives the same number either way.
function encodeInteger(v: number | bigint): Bytes {
  let value = v
  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value)
  }
  if (typeof value === "bigint") {
    if (value < -0x8000000000000000n || value > 0xffffffffffffffffn) {
      throw new Error("bplist: integer out of 64-bit range")
    }
    const out = new Uint8Array(9)
    out[0] = 0x13
    new DataView(out.buffer).setBigInt64(1, value, false)
    return out
  }
  if (value < 0) {
    if (value < -0x8000000000000000 || value > Number.MAX_SAFE_INTEGER) {
      throw new Error("bplist: integer out of 64-bit range")
    }
    const out = new Uint8Array(9)
    out[0] = 0x13
    new DataView(out.buffer).setBigInt64(1, BigInt(Math.trunc(value)), false)
    return out
  }
  const unsigned = value >>> 0
  if (value < 0x100) return concat(new Uint8Array([0x10]), new Uint8Array([unsigned]))
  if (value < 0x10000) return concat(new Uint8Array([0x11]), u16be(unsigned))
  if (value < 0x100000000) return concat(new Uint8Array([0x12]), u32be(unsigned))
  const out = new Uint8Array(9)
  out[0] = 0x13
  new DataView(out.buffer).setBigUint64(1, BigInt(Math.trunc(value)), false)
  return out
}

function writeSized(target: Bytes, at: number, size: number, value: number): void {
  for (let i = size - 1; i >= 0; i--) {
    target[at + i] = value & 0xff
    value = Math.floor(value / 256)
  }
}

function encodeIntMarker(count: number, kind: number): Bytes {
  if (count < 0x0f) return new Uint8Array([(kind << 4) | count])
  const size = count < 0x100 ? 1 : count < 0x10000 ? 2 : count < 0x100000000 ? 4 : 8
  const out = new Uint8Array(2 + size)
  out[0] = (kind << 4) | 0x0f
  out[1] = 0x10 | Math.log2(size)
  writeSized(out, 2, size, count)
  return out
}

function refBytes(index: number, refSize: number): Bytes {
  const out = new Uint8Array(refSize)
  writeSized(out, 0, refSize, index)
  return out
}

// MARK: - XML plist

export function parseXml(text: string): PlistValue {
  const tokens = new XmlCursor(text)
  // Skip prolog / doctype / comments.
  let node = tokens.next()
  while (node !== null && node.kind !== "open") node = tokens.next()
  if (node === null) throw new Error("plist xml: no root element")
  if (node.name !== "plist") throw new Error(`plist xml: root is <${node.name}>`)
  const inner = tokens.next()
  if (inner === null || inner.kind !== "open") throw new Error("plist xml: <plist> is empty")
  return readXmlValue(tokens, inner)
}

type XmlNode = { kind: "open", name: string, selfClosing: boolean } | { kind: "close", name: string } | { kind: "text", text: string }

class XmlCursor {
  private at = 0
  constructor(private readonly text: string) {}

  next(): XmlNode | null {
    while (true) {
      const lt = this.text.indexOf("<", this.at)
      if (lt === -1) {
        this.at = this.text.length
        return null
      }
      this.at = lt
      if (this.text.startsWith("<!--", lt)) {
        const end = this.text.indexOf("-->", lt)
        this.at = end === -1 ? this.text.length : end + 3
        continue
      }
      if (this.text.startsWith("<?", lt) || this.text.startsWith("<!", lt)) {
        const end = this.text.indexOf(">", lt)
        this.at = end === -1 ? this.text.length : end + 1
        continue
      }
      const end = this.text.indexOf(">", lt)
      if (end === -1) throw new Error("plist xml: unterminated tag")
      const raw = this.text.slice(lt + 1, end)
      this.at = end + 1
      if (raw.startsWith("/")) return { kind: "close", name: raw.slice(1).trim() }
      const selfClosing = raw.endsWith("/")
      const name = (selfClosing ? raw.slice(0, -1) : raw).split(/\s/)[0].trim()
      return { kind: "open", name, selfClosing }
    }
  }

  /** Text up to the next '<', entity-decoded. */
  textUntilTag(): string {
    const lt = this.text.indexOf("<", this.at)
    const raw = lt === -1 ? this.text.slice(this.at) : this.text.slice(this.at, lt)
    this.at = lt === -1 ? this.text.length : lt
    return decodeEntities(raw)
  }
}

function readXmlValue(tokens: XmlCursor, open: XmlNode & { kind: "open" }): PlistValue {
  const name = open.name
  if (open.selfClosing) {
    // plistlib emits self-closing tags for empty containers and values.
    switch (name) {
      case "true": return true
      case "false": return false
      case "string": return ""
      case "data": return new Uint8Array(0)
      case "array": return []
      case "dict": return {}
      case "integer": return 0
      case "real": return 0
      case "date": return new Date(0)
      default: throw new Error(`plist xml: <${name}/> is not a value`)
    }
  }
  switch (name) {
    case "true":
    case "false":
      return name === "true"
    case "string":
      return collectText(tokens, "string")
    case "integer":
      return parseInteger(collectText(tokens, "integer"))
    case "real":
      return new PlistReal(Number(collectText(tokens, "real")))
    case "date":
      return new Date(collectText(tokens, "date"))
    case "data":
      return fromBase64(collectText(tokens, "data").replace(/\s+/g, ""))
    case "array":
      return readXmlArray(tokens)
    case "dict":
      return readXmlDict(tokens)
    default:
      throw new Error(`plist xml: unexpected <${name}>`)
  }
}

function collectText(tokens: XmlCursor, name: string): string {
  const raw = tokens.textUntilTag()
  const close = tokens.next()
  if (close === null || close.kind !== "close" || close.name !== name) {
    throw new Error(`plist xml: <${name}> not closed`)
  }
  return raw
}

function parseInteger(text: string): number | bigint {
  const trimmed = text.trim()
  const value = BigInt(trimmed)
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  return value
}

function readXmlArray(tokens: XmlCursor): PlistValue[] {
  const out: PlistValue[] = []
  for (;;) {
    const node = tokens.next()
    if (node === null) throw new Error("plist xml: <array> not closed")
    if (node.kind === "close" && node.name === "array") return out
    if (node.kind !== "open") continue
    out.push(readXmlValue(tokens, node))
  }
}

function readXmlDict(tokens: XmlCursor): PlistDict {
  const out: PlistDict = {}
  let pendingKey: string | null = null
  for (;;) {
    const node = tokens.next()
    if (node === null) throw new Error("plist xml: <dict> not closed")
    if (node.kind === "close" && node.name === "dict") return out
    if (node.kind !== "open") continue
    if (node.name === "key") {
      pendingKey = collectText(tokens, "key")
      continue
    }
    if (pendingKey === null) throw new Error("plist xml: value before key")
    out[pendingKey] = readXmlValue(tokens, node)
    pendingKey = null
  }
}

function decodeEntities(raw: string): string {
  if (raw.indexOf("&") === -1) return raw
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
}

export function writeXml(value: PlistValue): string {
  const body = writeXmlValue(value, 0)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}</plist>\n`
}

/**
 * A real's text form for XML.
 *
 * Apple writes a whole-valued real without a decimal point — `<real>1000</real>` — which is what a
 * real `CodeResources` contains for its rule weights, and `String()` produces exactly that.
 *
 * Exponential notation is rejected rather than guessed at: its spelling in a plist is not known, and
 * emitting a possibly-wrong number is worse than refusing to.
 */
function formatReal(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`plist: ${value} cannot be written as a real`)
  const text = String(value)
  if (text.includes("e") || text.includes("E")) {
    throw new Error(
      `plist: ${value} would need exponential notation, whose spelling in a plist is not known here`,
    )
  }
  return text
}

function pad(depth: number): string {
  return "\t".repeat(depth)
}

function writeXmlValue(value: PlistValue, depth: number): string {
  const p = pad(depth)
  if (value === null) return `${p}<string></string>\n`
  if (value === true) return `${p}<true/>\n`
  if (value === false) return `${p}<false/>\n`
  if (value instanceof PlistUid) return `${p}<integer>${value.value}</integer>\n`
  // A real must go back out as a real.
  if (value instanceof PlistReal) return `${p}<real>${formatReal(value.value)}</real>\n`
  if (value instanceof Date) return `${p}<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>\n`
  if (value instanceof Uint8Array) {
    const b64 = toBase64(value)
    const lines: string[] = []
    // The base64 payload is indented to the SAME level as the `<data>` tag, not one deeper, which is
    // what Apple's own plist writer emits: indenting one level further makes the document a
    // different byte string.
    for (let i = 0; i < b64.length; i += 76) lines.push(`${pad(depth)}${b64.slice(i, i + 76)}`)
    return `${p}<data>\n${lines.join("\n")}\n${p}</data>\n`
  }
  if (typeof value === "string") return `${p}<string>${encodeEntities(value)}</string>\n`
  if (typeof value === "number" || typeof value === "bigint") {
    const isReal = typeof value === "number" && !Number.isInteger(value)
    return isReal ? `${p}<real>${value}</real>\n` : `${p}<integer>${value}</integer>\n`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${p}<array/>\n`
    return `${p}<array>\n${value.map(v => writeXmlValue(v, depth + 1)).join("")}${p}</array>\n`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return `${p}<dict/>\n`
  const parts = keys.map(k => `${pad(depth + 1)}<key>${encodeEntities(k)}</key>\n${writeXmlValue((value as PlistDict)[k], depth + 1)}`)
  return `${p}<dict>\n${parts.join("")}${p}</dict>\n`
}

function encodeEntities(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** Convenience for the common "dict with a few string values" case. */
export function plistFromRecord(record: Record<string, PlistValue>): PlistDict {
  return { ...record }
}

export type { Bytes }
