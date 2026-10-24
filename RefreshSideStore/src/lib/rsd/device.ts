// Reaching the device: the RSD tunnel, and one connection per service.
//
// The transport is the app's, not ours — `VPN.localDevVPN.openRSDTunnel` speaks TLS-PSK over the
// reflection, and what it returns has `connect({ port })`, a byte pipe to a port on the device.
// Getting there takes three steps: pair-verify against remoted on 49152, `createListener` for a port
// the device opens for us, then the tunnel.
//
// The RSD control connection goes on top: a fixed HTTP/2 handshake whose reply carries the service
// table, and every service after that is another `connect({ port })` to a port from that table.
import { PairStore, PairVerifyClient, SocketPeer, StreamChannel, type PairingFile } from "../rpp"
import { randomBytes, type Bytes } from "../util"
import { RsdClient, requireService, type RsdHandshake } from "./rsd"
import { TunnelStream, type ByteStream, type TunnelConnection } from "./stream"

/** remoted's remote-pairing port, which the reflection carries. */
export const REMOTED_PORT = 49152

/** What `VPN.localDevVPN.openRSDTunnel(...)` hands back, as far as this needs it. */
export interface RsdTunnel {
  getState(): Promise<{ state?: string, serverAddress?: string, rsdPort?: number }>
  connect(options: { port: number }): Promise<TunnelConnection> | TunnelConnection
  close(): Promise<void>
}

/**
 * One connection on the tunnel, with the call it was for named in any failure.
 *
 * The native layer's errors describe the session, not the service being dialled — "RSD requires a
 * valid numeric reflection address, port, 32-byte pairing key and valid tunnel options" came out of
 * a service connection, and reads as if the tunnel itself were misconfigured. The service name and
 * its port are the two facts that tell the difference.
 */
async function connectOn(tunnel: RsdTunnel, port: number, label: string): Promise<TunnelConnection> {
  try {
    return await tunnel.connect({ port })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`opening ${label} (port ${port}): ${message}`)
  }
}

export interface OpenDeviceOptions {
  /** The reflected IPv4 alias, which is where remoted and the tunnel are reached. */
  address: string
  /** RemotePairing port found by Bonjour, from SideStore logs, or default 49152. */
  remotedPort?: number
  /**
   * The record to verify with, when the caller holds one of its own — an imported file, a probe.
   * Defaults to the one this app saved, which is the only record the device is expected to know.
   */
  credentials?: { file: PairingFile, signingKey: CryptoKey }
  /** How long any single step may take. */
  stepTimeoutMs?: number
  /** Progress, in the caller's words. */
  onStep?: (message: string) => void
}

export interface DeviceLink {
  /** The service table the device answered with. */
  handshake: RsdHandshake
  /** A fresh connection to one service, by the name the table uses (`SERVICES.*`). */
  open: (serviceName: string) => Promise<ByteStream>
  /** Closes the tunnel. The caller's other connections die with it. */
  close: () => Promise<void>
}

/**
 * Opens the tunnel to the paired device and does the RSD handshake.
 *
 * The pairing file has to be the one `pairStep` saved: pair-verify authenticates the host by the
 * key inside it, and the device by the IRK it kept.
 */
export async function openDeviceLink(options: OpenDeviceOptions): Promise<DeviceLink> {
  const timeoutMs = options.stepTimeoutMs ?? 20_000
  const say = options.onStep ?? (() => {})
  const store = new PairStore()

  const file = options.credentials?.file ?? store.load()
  if (file === null) throw new Error("this device is not paired: there is no pairing file to verify with")
  const signingKey = options.credentials?.signingKey ?? await store.signingKey(await store.identity())

  // 1. pair-verify against remoted. The raw X25519 secret it produces is the tunnel's PSK.
  say("connecting to remoted")
  const net = require("node:net")
  const remotePort = options.remotedPort ?? REMOTED_PORT
  const socket = net.createConnection({ host: options.address, port: remotePort })
  try {
    await within(timeoutMs, `connecting to remoted at ${options.address}:${remotePort}`,
      new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve())
        socket.once("error", reject)
      }))
  } catch (error) {
    // The bare socket error ("Connection refused") names no target, and this is the dial whose failure
    // most often means the reflection underneath it is gone.
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`remoted at ${options.address}:${remotePort} could not be reached: ${message}`)
  }

  const peer = new SocketPeer(socket)
  const verified = await within(timeoutMs, "pair-verify",
    new PairVerifyClient({ file, signingKey }, peer).run())
  say("pair-verified")

  // 2. the port the device opens for the tunnel.
  const channel = await StreamChannel.connect(verified.preSharedKey, peer)
  const listenerPort = await within(timeoutMs, "createListener",
    channel.createListener(verified.preSharedKey))
  say(`the device opened a tunnel listener on ${listenerPort}`)

  // 3. the tunnel itself.
  const vpn: any = (globalThis as any).VPN
  if (vpn === undefined) throw new Error("this build has no VPN API")
  const tunnel: RsdTunnel = await within(timeoutMs * 2, "opening the RSD tunnel",
    vpn.localDevVPN.openRSDTunnel({
      host: options.address,
      port: listenerPort,
      preSharedKey: verified.preSharedKey,
    }))
  const state = await tunnel.getState()
  if (typeof state.rsdPort !== "number") {
    throw new Error(`the tunnel reported no RSD port: ${JSON.stringify(state)}`)
  }
  say(`tunnel up — RSD on port ${state.rsdPort} at ${state.serverAddress ?? options.address}`)

  // 4. the control connection, whose reply carries the service table. The UUID is ours to pick.
  const control = new TunnelStream(await connectOn(tunnel, state.rsdPort, "the RSD control connection"))
  const handshake = await within(timeoutMs, "the RSD handshake",
    RsdClient.connect(control, randomBytes(16) as Bytes))
  say(`the device advertised ${handshake.services.size} services`)

  try { socket.destroy() } catch { /* remoted may have closed it already */ }

  return {
    handshake,
    open: async serviceName => {
      const service = requireService(handshake, serviceName)
      return new TunnelStream(await connectOn(tunnel, service.port, serviceName))
    },
    close: async () => {
      try { await tunnel.close() } catch { /* the tunnel may be gone already */ }
    },
  }
}

/**
 * A step cannot be allowed to hang: `setTimeout` inside a socket callback is refused by the
 * runtime, so the timer is armed here, before anything async starts, and cancelled after.
 */
function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let handle: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => {
    if (handle !== null) clearTimeout(handle)
  })
}
