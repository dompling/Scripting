// A RemoteXPC conversation on one service port.
//
// The RSD control connection already speaks this: an eight-frame HTTP/2 handshake, then XPC
// messages. A CoreDevice or cryptexd service is the same conversation on its own port, with one
// difference — replies come back on the reply channel, not the root one.
//
// Payloads big enough to matter (a developer image) go out on streams of their own, which means
// the peer's flow-control window has to be honoured: it starts at 64 KiB and only grows when the
// device says so.
import { type Bytes, concat } from "../util"
import {
  REPLY_CHANNEL,
  ROOT_CHANNEL,
  XPC_FLAG,
  decodeXpcBody,
  decodeXpcMessage,
  encodeXpcBody,
  encodeXpcMessage,
  http2DataFrame,
  http2HeadersFrame,
  parseHttp2Frame,
  rsdHandshakeFrames,
  type XpcValue,
} from "../rpp"
import { toPlain } from "./rsd"
import type { ByteStream } from "./stream"

/** The HTTP/2 flow-control window before the peer says otherwise. */
const INITIAL_WINDOW = 65535
/** The largest DATA frame either side may send. */
const MAX_FRAME = 16384
/** Client-initiated streams start here: 1 and 3 are the root and reply channels. */
const FIRST_OUTBOUND_STREAM = 5

export class RemoteXpcSession {
  /** HTTP/2 frames can span reads, so the unframed tail lives here between calls. */
  private h2: Bytes = new Uint8Array(0)
  /** DATA payload accumulated per stream, also across reads. */
  private readonly streamData = new Map<number, Bytes>()
  /** How much each stream may still be sent, and the connection-wide budget beside it. */
  private readonly streamWindows = new Map<number, number>()
  private connectionWindow = INITIAL_WINDOW
  private defaultStreamWindow = INITIAL_WINDOW
  private nextStream = FIRST_OUTBOUND_STREAM

  private constructor(private readonly stream: ByteStream) {}

  /** Sends the handshake every RemoteXPC peer expects; no device handshake on a service port. */
  static async open(stream: ByteStream): Promise<RemoteXpcSession> {
    const session = new RemoteXpcSession(stream)
    for (const frame of rsdHandshakeFrames()) await stream.write(frame)
    return session
  }

  /** One method call. Replies arrive on the reply channel. */
  async send(value: XpcValue): Promise<void> {
    const flags = XPC_FLAG.DataFlag | XPC_FLAG.AlwaysSet | XPC_FLAG.WantingReply
    const message = encodeXpcMessage(flags, encodeXpcBody(value), 1n)
    await this.writeStream(ROOT_CHANNEL, message)
  }

  /**
   * The next message with a body, as plain JavaScript.
   *
   * Empty dictionaries and bodyless frames are the peer's keepalives: they are skipped rather than
   * handed to a caller that is waiting for an answer.
   */
  async receive(): Promise<unknown> {
    for (;;) {
      const body = this.take(REPLY_CHANNEL)
      if (body !== undefined) {
        if (body === null) continue
        const plain = toPlain(body)
        if (plain === null) continue
        if (typeof plain === "object" && !Array.isArray(plain) && !(plain instanceof Uint8Array)) {
          if (Object.keys(plain as Record<string, unknown>).length === 0) continue
        }
        return plain
      }
      await this.readMore()
    }
  }

  /**
   * Pushes one payload as its own stream: HEAders, a file-transfer preamble, the bytes, then the
   * end of the stream.
   *
   * `transferId` is the id the request announced (`xpcFileTransfer`), and `index` orders the
   * streams the way the request listed them.
   */
  async sendFileTransfer(index: number, transferId: bigint, payload: Bytes): Promise<void> {
    const streamId = this.nextStream + index * 2
    await this.stream.write(http2HeadersFrame(streamId))
    const preamble = encodeXpcMessage(
      XPC_FLAG.FileTxStreamRequest | XPC_FLAG.AlwaysSet, null, transferId)
    await this.writeStream(streamId, preamble)
    await this.writeStream(streamId, payload)
    await this.stream.write(http2DataFrame(new Uint8Array(0), streamId, true))
  }

  async close(): Promise<void> {
    if (this.stream.close !== undefined) await this.stream.close()
  }

  /** Writes one message, splitting it and waiting whenever the peer's window is spent. */
  private async writeStream(streamId: number, bytes: Bytes): Promise<void> {
    let at = 0
    while (at < bytes.length) {
      const room = await this.reserveWindow(streamId)
      const piece = bytes.subarray(at, at + room)
      await this.stream.write(http2DataFrame(piece, streamId))
      at += piece.length
    }
  }

  /** How much may go out now; reads frames until the answer is not zero. */
  private async reserveWindow(streamId: number): Promise<number> {
    for (;;) {
      const streamRoom = this.windowOf(streamId)
      const room = Math.min(streamRoom, this.connectionWindow, MAX_FRAME)
      if (room > 0) {
        this.streamWindows.set(streamId, streamRoom - room)
        this.connectionWindow -= room
        return room
      }
      await this.readMore()
    }
  }

  private windowOf(streamId: number): number {
    return this.streamWindows.get(streamId) ?? this.defaultStreamWindow
  }

  private async readMore(): Promise<void> {
    const chunk = await this.stream.read()
    if (chunk === null) throw new Error("remote xpc: the device closed while a message was expected")
    this.push(chunk)
  }

  /** Appends a chunk and drains every complete HTTP/2 frame it completes. */
  private push(chunk: Bytes): void {
    this.h2 = concat(this.h2, chunk)
    for (;;) {
      const parsed = parseHttp2Frame(this.h2)
      if (parsed === null) return
      this.h2 = this.h2.subarray(parsed.consumed)

      const frame = parsed.frame
      if (frame.type === "settings") {
        for (const [id, value] of frame.settings) {
          if (id !== 0x04) continue
          // Streams already open move by the same difference, as HTTP/2 requires.
          const delta = value - this.defaultStreamWindow
          this.defaultStreamWindow = value
          for (const [stream, window] of this.streamWindows) {
            this.streamWindows.set(stream, window + delta)
          }
        }
        continue
      }
      if (frame.type === "windowUpdate") {
        if (frame.streamId === 0) this.connectionWindow += frame.increment
        else this.streamWindows.set(frame.streamId, this.windowOf(frame.streamId) + frame.increment)
        continue
      }
      if (frame.type !== "data") continue

      const previous = this.streamData.get(frame.streamId)
      this.streamData.set(frame.streamId, concat(previous ?? new Uint8Array(0), frame.payload))
    }
  }

  /** One whole message off `channel`, `undefined` while the buffer holds no complete one. */
  private take(channel: number): XpcValue | null | undefined {
    const buffer = this.streamData.get(channel)
    if (buffer === undefined || buffer.length === 0) return undefined

    const message = decodeXpcMessage(buffer)
    if (message === null) return undefined

    const bodyLength = message.body === null ? 0 : message.body.length
    this.streamData.set(channel, buffer.subarray(24 + bodyLength))

    if (message.body === null || bodyLength === 0) return null
    return decodeXpcBody(message.body)
  }
}
