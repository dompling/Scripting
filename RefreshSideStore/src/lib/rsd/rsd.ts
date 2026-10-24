// The RSD control connection.
//
// This is HTTP/2 with no TLS carrying XPC: the client sends a fixed eight-frame handshake and
// the device answers with a dictionary whose `Services` table maps service names to the ports
// they listen on. Everything after that is a plain TCP connection to one of those ports.
//
// `openRSDTunnel` gives us the transport; this owns the protocol above it.
import type { Bytes } from "../util"
import { concat } from "../util"
import {
  ROOT_CHANNEL,
  decodeXpcBody,
  decodeXpcMessage,
  deviceHandshakeFrame,
  parseHttp2Frame,
  rsdHandshakeFrames,
  type XpcValue,
} from "../rpp"
import { StreamReader, type ByteStream } from "./stream"

/** One entry of the `Services` table. */
export interface RsdService {
  name: string
  /** The device reports this as a STRING, not an integer. */
  port: number
  entitlement: string
  usesRemoteXpc: boolean
  serviceVersion: number
  features: string[]
}

export interface RsdHandshake {
  services: Map<string, RsdService>
  messagingProtocolVersion: number
  uuid: string
  properties: Record<string, unknown>
}

function parseService(name: string, entry: unknown): RsdService | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) || entry instanceof Uint8Array) {
    return null
  }
  const dict = entry as Record<string, unknown>

  // A string on the wire; parsed rather than assumed to be an integer.
  const port = asInteger(dict.Port)

  const entitlement = dict.Entitlement
  if (typeof entitlement !== "string" || port === null || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }

  const properties = dict.Properties
  const props = (properties !== null && typeof properties === "object" && !Array.isArray(properties))
    ? properties as Record<string, unknown>
    : {}

  return {
    name,
    port,
    entitlement,
    usesRemoteXpc: props.UsesRemoteXPC === true,
    serviceVersion: asInteger(props.ServiceVersion) ?? 0,
    features: Array.isArray(props.Features)
      ? props.Features.filter((f): f is string => typeof f === "string")
      : [],
  }
}

/** 2**53 - 1: the largest integer a double holds exactly. */
const MAX_EXACT_INTEGER = 9007199254740991n

/**
 * An XPC integer as a JavaScript number.
 *
 * Both of XPC's integer types arrive as `bigint`, and everything the handshake reads — a protocol
 * version, a service version — is a small number: narrowing here is what keeps `typeof x ===
 * "number"` meaning what it says. Before this, a reply carrying `MessagingProtocolVersion` as an XPC
 * integer reached the parser as a bigint and was rejected as a *missing* field on a real device,
 * while every synthetic reply (a hand-built JavaScript object) passed.
 *
 * A value a double cannot hold exactly stays a bigint rather than being rounded —
 * `RemoteXPCVersionFlags` is one.
 */
function asNumber(value: bigint): number | bigint {
  return value >= -MAX_EXACT_INTEGER && value <= MAX_EXACT_INTEGER ? Number(value) : value
}

/**
 * A field that has more than one spelling on the wire, as a number or null.
 *
 * `Port` arrives as a string, `ServiceVersion` as a signed or unsigned integer, and neither is
 * guaranteed to stay that way; the reference reader has the same tolerance in one place per field.
 */
function asInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** How a field that failed to parse is best described: absent is not the same as the wrong type. */
function describeField(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (value instanceof Uint8Array) return `${value.length} bytes`
  return `a ${typeof value}`
}

/** A 16-byte uuid in the form Rust's `Uuid::to_string()` gives it: lower case, hyphenated. */
function uuidToString(bytes: Bytes): string {
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The device's RSD UUID as text, however it arrived.
 *
 * It comes as XPC's uuid type (and `toPlain` has already turned that into the string form), but a
 * reply that spells the same value out has to work as well — the field is read the same way either.
 */
function asUuid(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value
  if (value instanceof Uint8Array && value.length === 16) return uuidToString(value)
  return null
}

/** Converts the XPC object tree into plain JS so callers do not carry the tags around. */
export function toPlain(value: XpcValue): unknown {
  switch (value.type) {
    case "null": return null
    case "int64":
    case "uint64":
      return asNumber(value.value)
    case "uuid":
      // A device sends its RSD identity as XPC's uuid type. The reference reader never sees those
      // bytes: its decoder turns a uuid into a string on the way out, which is why its own
      // `as_string()` lookup works — and this one has to do the same, or the field reads as an object.
      return uuidToString(value.value)
    case "bool":
    case "double":
    case "string":
    case "date":
    case "data":
      return value.value
    case "array":
      return value.value.map(toPlain)
    case "dictionary": {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of value.value) out[key] = toPlain(entry)
      return out
    }
    case "fileTransfer":
      return toPlain(value.value)
  }
}

export class RsdClient {
  private readonly reader: StreamReader
  /** HTTP/2 frames can span reads, so the unframed tail lives here between calls. */
  private h2: Bytes = new Uint8Array(0)
  /** DATA payload accumulated per stream, also across reads. */
  private readonly streamData = new Map<number, Bytes>()

  private constructor(private readonly stream: ByteStream) {
    this.reader = new StreamReader(stream)
  }

  /** Sends the fixed handshake and returns the parsed service table. */
  static async connect(stream: ByteStream, uuid: Bytes): Promise<RsdHandshake> {
    const client = new RsdClient(stream)
    for (const frame of rsdHandshakeFrames()) await stream.write(frame)
    await stream.write(deviceHandshakeFrame(uuid))
    return client.awaitHandshake()
  }

  /**
   * Reads until a body arrives on the root channel.
   *
   * Keepalives (an empty body) and bodyless frames yield null and the caller retries — the
   * device sends both while it is still working.
   */
  async readRootBody(): Promise<XpcValue | null> {
    for (;;) {
      const ready = this.takeMessage(ROOT_CHANNEL)
      if (ready !== undefined) return ready

      const chunk = await this.stream.read()
      if (chunk === null) throw new Error("rsd: the device closed while a reply was expected")
      this.push(chunk)
    }
  }

  /** Appends a chunk and drains every complete HTTP/2 frame it completes. */
  private push(chunk: Bytes): void {
    this.h2 = concat(this.h2, chunk)
    for (;;) {
      const parsed = parseHttp2Frame(this.h2)
      if (parsed === null) return
      this.h2 = this.h2.subarray(parsed.consumed)
      // HEADERS, SETTINGS, WINDOW_UPDATE, RST_STREAM and GOAWAY carry no XPC payload.
      if (parsed.frame.type === "data") {
        const previous = this.streamData.get(parsed.frame.streamId)
        this.streamData.set(parsed.frame.streamId, concat(previous ?? new Uint8Array(0), parsed.frame.payload))
      }
    }
  }

  /**
   * One whole XPC message off `channel`, or `undefined` when the buffer does not hold one yet,
   * or null when the message has no body (a keepalive).
   */
  private takeMessage(channel: number): XpcValue | null | undefined {
    const buffer = this.streamData.get(channel)
    if (buffer === undefined || buffer.length === 0) return undefined

    const message = decodeXpcMessage(buffer)
    if (message === null) return undefined

    const bodyLength = message.body === null ? 0 : message.body.length
    this.streamData.set(channel, buffer.subarray(24 + bodyLength))

    if (message.body === null || bodyLength === 0) return null
    return decodeXpcBody(message.body)
  }

  private async awaitHandshake(): Promise<RsdHandshake> {
    for (;;) {
      const body = await this.readRootBody()
      if (body === null) continue
      const plain = toPlain(body)
      if (plain === null || typeof plain !== "object" || Array.isArray(plain)) continue
      const dict = plain as Record<string, unknown>
      // The reply we want is the one carrying the service table.
      if (dict.Services === undefined) continue
      return parseHandshake(dict)
    }
  }
}

export function parseHandshake(dict: Record<string, unknown>): RsdHandshake {
  const services = new Map<string, RsdService>()
  const raw = dict.Services
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      const service = parseService(name, entry)
      // Skipping an entry is not fatal: a device advertises services we never open.
      if (service !== null) services.set(name, service)
    }
  }
  if (services.size === 0) throw new Error("rsd: the handshake carried no usable services")

  const version = asInteger(dict.MessagingProtocolVersion)
  if (version === null) {
    // Naming what arrived matters: "absent" and "a bigint" need different fixes, and this message
    // used to say "no MessagingProtocolVersion" for both.
    throw new Error(`rsd: the handshake's MessagingProtocolVersion was ${describeField(dict.MessagingProtocolVersion)}, not an integer`)
  }

  const uuid = asUuid(dict.UUID)
  if (uuid === null) {
    throw new Error(`rsd: the handshake's UUID was ${describeField(dict.UUID)}, not a uuid or string`)
  }

  const properties = dict.Properties
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`rsd: the handshake's Properties were ${describeField(dict.Properties)}, not a dictionary`)
  }

  return {
    services,
    messagingProtocolVersion: version,
    uuid,
    properties: properties as Record<string, unknown>,
  }
}

/** Looks a service up by name, with a message that names what the device did offer. */
export function requireService(handshake: RsdHandshake, name: string): RsdService {
  const service = handshake.services.get(name)
  if (service === undefined) {
    const offered = Array.from(handshake.services.keys()).sort().join(", ")
    throw new Error(`rsd: the device does not offer ${name} (it offers: ${offered})`)
  }
  return service
}
