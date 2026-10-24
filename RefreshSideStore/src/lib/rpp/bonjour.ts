// Publishing the pairable host over Bonjour.
//
// The device finds us by browsing `_remotepairing-pairable-host._tcp`, matching on the
// `identifier` and validating the `authTag` — which is why both must be stable across runs.
import { authTag } from "./siphash"

export const PAIRABLE_HOST_TYPE = "_remotepairing-pairable-host._tcp"
export const REMOTE_PAIRING_TYPE = "_remotepairing._tcp"

/** The wire protocol version the reference advertises, and the oldest it accepts. */
export const WIRE_PROTOCOL_VERSION = 26
export const MIN_WIRE_PROTOCOL_VERSION = 17

/** The seven keys a pairable-host TXT record carries, in the order the reference builds them. */
export const TXT_KEYS_EXPECTED = ["name", "identifier", "authTag", "model", "flags", "ver", "minVer"]

export interface PairableHostInfo {
  /** Shown to the user on the device. */
  name: string
  /** The stable service identifier; also the Bonjour instance name. */
  identifier: string
  /** A Mac model string: the device treats a pairable host as a computer. */
  model: string
  /** The host's own 16-byte IRK, which the authTag derives from. */
  altIrk: Uint8Array
}

/**
 * The seven TXT keys the reference publishes, in the order it builds them. A device that has
 * paired before recognises this host by `identifier` plus `authTag`; get the tag wrong and the
 * device simply never offers to pair.
 */
export function pairableHostTxt(info: PairableHostInfo): Record<string, string> {
  if (info.altIrk.length !== 16) {
    throw new Error(`bonjour: altIrk must be 16 bytes, got ${info.altIrk.length}`)
  }
  return {
    name: info.name,
    identifier: info.identifier,
    authTag: authTag(info.altIrk, info.identifier),
    model: info.model,
    flags: "1",
    ver: String(WIRE_PROTOCOL_VERSION),
    minVer: String(MIN_WIRE_PROTOCOL_VERSION),
  }
}

export interface PublishedHost {
  name: string
  type: string
  port: number
  stop(): void
}

export interface PublishOptions {
  info: PairableHostInfo
  /** The port the TCP listener is actually bound to. */
  port: number
  /** Advertise over peer-to-peer Wi-Fi as well as the LAN. */
  includePeerToPeer?: boolean
}

/**
 * Publishes the pairable host. Resolves once the system has taken the registration.
 *
 * A name collision rejects rather than renaming, so the identifier doubles as a uniqueness
 * guarantee: two of our own runs cannot both advertise the same instance.
 */
export async function publishPairableHost(options: PublishOptions): Promise<PublishedHost> {
  const Bonjour: any = (globalThis as any).Bonjour
  if (Bonjour === undefined) throw new Error("bonjour: this build of Scripting has no Bonjour API")

  const txtRecord = pairableHostTxt(options.info)
  const publication = await Bonjour.publish({
    name: options.info.identifier,
    type: PAIRABLE_HOST_TYPE,
    port: options.port,
    txtRecord,
    includePeerToPeer: options.includePeerToPeer ?? false,
  })

  return {
    name: publication.name ?? options.info.identifier,
    type: PAIRABLE_HOST_TYPE,
    port: publication.port ?? options.port,
    stop: () => { publication.stop() },
  }
}

/**
 * Looks for our own advertisement, and says whether it answered.
 *
 * `publish` resolving only means the system took the registration — not that anything can find it.
 * Browsing for the same instance is the cheapest way to tell "this advertisement is a no-op" from
 * "the device ignores it", and those two need completely different fixes.
 */
export async function seesOwnPairableHost(identifier: string, timeoutMs = 3000): Promise<boolean> {
  const Bonjour: any = (globalThis as any).Bonjour
  if (Bonjour === undefined) return false

  return await new Promise<boolean>(resolve => {
    let settled = false
    let browser: any = null
    const settle = (found: boolean) => {
      if (settled) return
      settled = true
      try { browser?.stop() } catch { /* already stopped */ }
      resolve(found)
    }
    // Armed before the browser exists, and never cleared from a callback: a timer made inside one
    // is rejected by the runtime (see `scripting-websocket-no-timers`).
    setTimeout(() => settle(false), timeoutMs)
    try {
      browser = Bonjour.browse({
        type: PAIRABLE_HOST_TYPE,
        includePeerToPeer: true,
        onFound: (service: any) => { if (service?.name === identifier) settle(true) },
        onError: () => settle(false),
      })
    } catch {
      settle(false)
    }
  })
}

/** Total encoded size of a TXT record, for the API's 1300-byte ceiling. */
