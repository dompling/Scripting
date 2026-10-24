// The byte-stream plumbing the RSD services share.
//
// Everything above the tunnel speaks the same shape: a buffered reader over a
// request/response pipe, and the "u32 big-endian length then an XML plist" protocol that the
// `.shim.remote` services use for their check-in and their commands.
import type { Bytes } from "../util"
import { concat, fromUtf8, readU32be, toHex, u32be, utf8 } from "../util"
import { parsePlist, writeXml, type PlistDict, type PlistValue } from "../util"

/**
 * The shape `VPN.localDevVPN.openRSDTunnel(...).connect({port})` hands back, and the shape a
 * node:net socket can be adapted to. Reads are bounded and may return null at EOF.
 */
export interface ByteStream {
  read(maximum?: number): Promise<Bytes | null>
  write(bytes: Bytes | ArrayBuffer): Promise<void>
  /**
   * Closes this connection without touching the tunnel. A tunnel allows four connections at a
   * time, so a service that is done is closed rather than held to the end of the step.
   */
  close?(): Promise<void>
}

/** Adapts a node:net socket to `ByteStream`, for tests and for any non-tunnel use. */
export class SocketStream implements ByteStream {
  private readonly chunks: Bytes[] = []
  private wake: (() => void) | null = null
  private closed = false

  constructor(private readonly socket: any) {
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
  }

  async read(maximum = 16384): Promise<Bytes | null> {
    for (;;) {
      const chunk = this.chunks.shift()
      if (chunk !== undefined) {
        return chunk.length <= maximum ? chunk : chunk.subarray(0, maximum)
      }
      if (this.closed) return null
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }

  async write(bytes: Bytes | ArrayBuffer): Promise<void> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    await new Promise<void>((resolve, reject) => {
      this.socket.write(view, (error?: Error) => (error ? reject(error) : resolve()))
    })
  }
}

/**
 * The most the tunnel's connection takes in one call.
 *
 * Scripting documents reads and writes through `openRSDTunnel` as bounded to 16384 bytes, while the
 * AFC layer above chunks at 1 MiB because that is what libimobiledevice uses over a real socket
 * (`afc.ts`'s `AFC_MAX_TRANSFER`). The bound belongs to the transport, so it is applied here rather
 * than by shrinking every protocol's packet size: a protocol writes its packet, this splits it.
 *
 * A write larger than this is what a real device rejected: the upload finished its first (small)
 * file and the next operation came back with a native error that named no size at all.
 */
export const TUNNEL_MAX_TRANSFER = 16384

/** The shape `VPN.localDevVPN.openRSDTunnel(...).connect({port})` hands back. */
export interface TunnelConnection {
  read(maximum: number): Promise<Bytes | null>
  write(bytes: Bytes | ArrayBuffer): Promise<void>
  close?(): Promise<void>
}

/**
 * The tunnel's connection as a `ByteStream`.
 *
 * Writes are split at the transport's bound; the receiver reassembles them, and every protocol here
 * is a byte stream rather than a message stream, so a split inside a packet is safe.
 */
export class TunnelStream implements ByteStream {
  constructor(private readonly connection: TunnelConnection) {}

  async read(maximum = TUNNEL_MAX_TRANSFER): Promise<Bytes | null> {
    const chunk = await this.connection.read(Math.min(maximum, TUNNEL_MAX_TRANSFER))
    if (chunk === null) return null
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  }

  async write(bytes: Bytes | ArrayBuffer): Promise<void> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    for (let offset = 0; offset < view.length; offset += TUNNEL_MAX_TRANSFER) {
      await this.connection.write(view.subarray(offset, offset + TUNNEL_MAX_TRANSFER))
    }
  }

  async close(): Promise<void> {
    if (this.connection.close !== undefined) await this.connection.close()
  }
}

/** Accumulates stream chunks and hands out exact byte counts. */
export class StreamReader {
  private buffer: Bytes = new Uint8Array(0)

  constructor(private readonly stream: ByteStream) {}

  /** Reads exactly `count` bytes, or throws if the peer ends first. */
  async exact(count: number): Promise<Bytes> {
    while (this.buffer.length < count) {
      const chunk = await this.stream.read()
      if (chunk === null) {
        throw new Error(`stream: the peer ended with ${this.buffer.length} of ${count} bytes`)
      }
      this.buffer = concat(this.buffer, chunk)
    }
    const out = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return out
  }

  /**
   * Reads until `done` is satisfied, feeding it everything available. Used by protocols whose
   * replies are a stream of plists rather than a fixed count.
   */
  async until<T>(done: (reader: StreamReader) => T | null): Promise<T> {
    for (;;) {
      const ready = done(this)
      if (ready !== null) return ready
      const chunk = await this.stream.read()
      if (chunk === null) throw new Error("stream: the peer ended while a reply was expected")
      this.buffer = concat(this.buffer, chunk)
    }
  }

  /** Bytes held back waiting for the rest of a message. */
  get buffered(): number {
    return this.buffer.length
  }

  /** Looks at the head without consuming it. */
  peek(count: number): Bytes | null {
    return this.buffer.length < count ? null : this.buffer.subarray(0, count)
  }

  /** Consumes `count` bytes already known to be present. */
  take(count: number): Bytes {
    const out = this.buffer.subarray(0, count)
    this.buffer = this.buffer.subarray(count)
    return out
  }

  push(bytes: Bytes): void {
    this.buffer = concat(this.buffer, bytes)
  }
}

// MARK: - the length-prefixed plist protocol

/**
 * Wraps a value in the framing every `.shim.remote` service uses: a u32 big-endian length,
 * then an XML plist. Binary plists are accepted on read (the reference does the same) but
 * never written.
 */
export function plistFrame(value: PlistValue): Bytes {
  const xml = writeXml(value)
  const body = utf8(xml)
  return concat(u32be(body.length), body)
}

/** Serialises a dictionary as one framed plist. */
export function plistFrameDict(dict: PlistDict): Bytes {
  return plistFrame(dict)
}

export class PlistStream {
  private readonly reader: StreamReader

  constructor(private readonly stream: ByteStream) {
    this.reader = new StreamReader(stream)
  }

  /** Sends one dictionary as a framed plist. */
  async send(dict: PlistDict): Promise<void> {
    await this.stream.write(plistFrameDict(dict))
  }

  /** Sends raw bytes, for the protocols that interleave frames with payloads (AFC does). */
  async write(bytes: Bytes): Promise<void> {
    await this.stream.write(bytes)
  }

  /** The next framed plist, or null when the peer has ended. */
  async receive(): Promise<PlistDict | null> {
    return this.reader.until<PlistDict | null>(reader => {
      const head = reader.peek(4)
      if (head === null) return null
      const length = readU32be(head, 0)
      if (length === 0 || length > 64 * 1024 * 1024) {
        throw new Error(`plist stream: implausible frame length ${length}`)
      }
      if (reader.buffered < 4 + length) return null
      reader.take(4)
      const body = reader.take(length)
      // Bytes, never text: this service mixes XML and binary plists (the reference reads both with one
      // parser), and a binary body decoded as UTF-8 cannot be recovered afterwards — which is how a
      // real install ended with "the frame was not a dictionary" while its bytes were a fine plist.
      // The hex is here because that failure was diagnosable only by guesswork without it.
      let parsed: PlistValue
      try {
        parsed = parsePlist(body)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `plist stream: a ${length}-byte frame starting ${toHex(body.subarray(0, 8))} would not parse: ${reason}`,
        )
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed instanceof Uint8Array) {
        throw new Error(
          `plist stream: a ${length}-byte frame starting ${toHex(body.subarray(0, 8))} was not a dictionary`,
        )
      }
      return parsed as PlistDict
    })
  }
}

export const RSD_PROTOCOL_VERSION = "2"

/** The service names the install path needs. */
export const SERVICES = {
  installationProxy: "com.apple.mobile.installation_proxy.shim.remote",
  afc: "com.apple.afc.shim.remote",
  houseArrest: "com.apple.mobile.house_arrest.shim.remote",
  lockdown: "com.apple.mobile.lockdown.remote.trusted",
  misagent: "com.apple.misagent.shim.remote",
} as const

/**
 * The handshake every `.shim.remote` service wants before it will talk: announce ourselves,
 * then read back `RSDCheckin` followed by `StartService`.
 *
 * Both replies are asserted rather than ignored. A service that answers with something else is
 * one we have misunderstood, and finding that out here is much cheaper than three layers later.
 */
export async function rsdCheckin(stream: ByteStream, label: string): Promise<PlistDict> {
  const plists = new PlistStream(stream)

  await stream.write(plistFrameDict({
    Label: label,
    ProtocolVersion: RSD_PROTOCOL_VERSION,
    Request: "RSDCheckin",
  }))

  const checkin = await plists.receive()
  if (checkin === null) throw new Error("rsd: the service closed during the check-in")
  const checkinRequest = checkin.Request
  if (checkinRequest !== "RSDCheckin") {
    throw new Error(`rsd: expected RSDCheckin, got ${JSON.stringify(checkinRequest)}`)
  }

  const started = await plists.receive()
  if (started === null) throw new Error("rsd: the service closed before StartService")
  const startRequest = started.Request
  if (startRequest !== "StartService") {
    throw new Error(`rsd: expected StartService, got ${JSON.stringify(startRequest)}`)
  }

  return started
}
