// Read real expiration dates from the device: RPPairing -> RSD -> Misagent, then intersect
// profiles with InstallationProxy's live app inventory so stale profiles are never displayed.
import { parseProvisioningProfile } from "./lib/sign/provisioning"
import { PairStore } from "./lib/rpp/pairstore"
import { nativePair, type PairResult } from "./lib/reader/native-pair"
import { openDeviceLink, MisagentClient, probeTcp, SERVICES } from "./lib/rsd"
import { listInstalledApps } from "./lib/rsd/installed-apps"
import { isExtensionId, isShortTermDevelopmentProfile } from "./lib/reader/filter"
import type { AppRecord } from "./model"

export const RPP_HOST_KEY = "rpp.expiry.host.v1"
export const RPP_PORT_KEY = "rpp.expiry.port.v1"

function bundleFromApplicationIdentifier(applicationIdentifier: string | null): string | null {
  if (!applicationIdentifier) return null
  const matched = /^[A-Z0-9]{10}\.(.+)$/.exec(applicationIdentifier)
  const bundle = matched ? matched[1] : applicationIdentifier
  return bundle === "*" || bundle.length === 0 ? null : bundle
}

function displayName(info: Record<string, unknown>, fallback: string): string {
  for (const key of ["CFBundleDisplayName", "CFBundleName", "CFBundleExecutable"]) {
    const value = info[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return fallback
}

export function rppHost(): string {
  const saved = (Storage.get<string>(RPP_HOST_KEY) ?? "10.7.0.1").trim()
  const parts = saved.split(".")
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ? saved : "10.7.0.1"
}

export function saveRppHost(host: string): void {
  Storage.set(RPP_HOST_KEY, host.trim())
}

export function rppPort(): string {
  const saved = Storage.get<string>(RPP_PORT_KEY) ?? "62554"
  return /^\d{1,5}$/.test(saved) && Number(saved) > 0 && Number(saved) <= 65535 ? saved : "62554"
}

export function saveRppPort(port: string): void {
  Storage.set(RPP_PORT_KEY, port.trim())
}

function validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535 }

/** Best-effort RemotePairing service discovery, identical to the expiry reader's fallback strategy. */
async function discoverBonjourPorts(log: (message: string) => void, timeoutMs = 1400): Promise<number[]> {
  const Bonjour: any = (globalThis as any).Bonjour
  if (!Bonjour || typeof Bonjour.browse !== "function") return []
  const ports = new Set<number>()
  let browser: any = null
  let finish = () => {}
  const finished = new Promise<void>(resolve => { finish = resolve })
  const timer = setTimeout(() => finish(), timeoutMs)
  try {
    browser = Bonjour.browse({
      type: "_remotepairing._tcp", includePeerToPeer: true,
      onFound: (service: any) => { const port = Number(service?.port); if (validPort(port)) ports.add(port) },
      onError: () => finish(),
    })
    await finished
  } catch (error) {
    log(`Bonjour 探测不可用：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    try { browser?.stop?.() } catch {}
  }
  return Array.from(ports)
}

async function candidatePorts(preferred: number, log: (message: string) => void): Promise<number[]> {
  const bonjour = await discoverBonjourPorts(log)
  const ports = Array.from(new Set([preferred, ...bonjour, 62554, 49152].filter(validPort)))
  log(`候选 RemotePairing 端口：${ports.join(", ")}`)
  return ports
}

export function hasRppPairing(): boolean {
  return new PairStore().hasDeviceIrk()
}

/** Starts iOS Remote Pairing and stores this script's verified pairing record. */
export async function pairRppDevice(log: (message: string) => void = () => {}): Promise<PairResult> {
  return nativePair(log)
}

/** Imports a verified RPP pairing record in XML, binary plist, or supported JSON form. */
export async function importRppPairingRecord(input: string | Uint8Array): Promise<{ name: string, udid: string }> {
  return new PairStore().importRecord(input)
}

export interface RppExpiryResult {
  apps: AppRecord[]
  profilesRead: number
  installedApps: number
  host: string
  port: number
}

export async function readExpiryViaRpp(host: string, preferredPort: number, log: (message: string) => void = () => {}): Promise<RppExpiryResult> {
  const pair = new PairStore()
  if (!pair.hasDeviceIrk()) throw new Error("没有 RPP 配对记录。请先完成设备配对，或从文件/剪贴板导入已有配对记录。")
  const address = rppHost() === host ? host : host.trim()
  const ports = await candidatePorts(validPort(preferredPort) ? preferredPort : 62554, log)
  let link: Awaited<ReturnType<typeof openDeviceLink>> | null = null
  let chosenPort = 0
  const failures: string[] = []
  for (const port of ports) {
    const probe = await probeTcp(address, port, 1800)
    if (!probe.open) {
      failures.push(`${port}: ${probe.code ?? "不可达"}`)
      log(`${address}:${port} 不可达（${probe.code ?? "未知"}）`)
      continue
    }
    log(`${address}:${port} 可连接，正在 pair-verify…`)
    try {
      link = await openDeviceLink({ address, remotedPort: port, stepTimeoutMs: 11000, onStep: log })
      chosenPort = port
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${port}: ${message}`)
      log(`端口 ${port} 建立隧道失败：${message}`)
    }
  }
  if (link === null) throw new Error(`未能建立只读 RSD 会话。${failures.join("；").slice(0, 1200)}`)
  try {
    log("正在读取系统描述文件…")
    const misagent = await MisagentClient.connect(await link.open(SERVICES.misagent), "RefreshSideStore-expiry-read")
    let profiles: Uint8Array[]
    try { profiles = await misagent.copyAll() } finally { await misagent.disconnect() }
    const installed = await listInstalledApps(link, log)
    const best = new Map<string, { expiresAt: number, refreshedAt?: number }>()
    for (const raw of profiles) {
      try {
        const profile = parseProvisioningProfile(raw)
        const bundle = bundleFromApplicationIdentifier(profile.applicationIdentifier)
        if (!bundle || !installed.has(bundle) || profile.expirationDate === null || isExtensionId(bundle)) continue
        const refreshedAt = profile.plist.CreationDate instanceof Date ? profile.plist.CreationDate.getTime() : undefined
        const isPersonalShortTerm = isShortTermDevelopmentProfile({
          createdAt: refreshedAt === undefined ? null : new Date(refreshedAt).toISOString(),
          expiresAt: profile.expirationDate.toISOString(),
          getTaskAllow: profile.entitlements["get-task-allow"] === true,
          hasProvisionedDevices: profile.provisionedDevices !== null,
          provisionsAllDevices: profile.plist.ProvisionsAllDevices === true,
        })
        if (!isPersonalShortTerm) continue
        const old = best.get(bundle)
        if (!old || (refreshedAt ?? 0) >= (old.refreshedAt ?? 0)) {
          best.set(bundle, { expiresAt: profile.expirationDate.getTime(), refreshedAt })
        }
      } catch {
        // Ignore an individual malformed profile; the verified installed inventory remains valid.
      }
    }
    const apps = Array.from(best, ([bundleIdentifier, dates]) => ({
      name: displayName(installed.get(bundleIdentifier)! as Record<string, unknown>, bundleIdentifier),
      bundleIdentifier,
      expiresAt: dates.expiresAt,
      refreshedAt: dates.refreshedAt,
    })).sort((a, b) => a.expiresAt - b.expiresAt)
    if (!apps.length) throw new Error("未找到与系统已安装 App 精确匹配的有效描述文件")
    Storage.set(RPP_PORT_KEY, String(chosenPort))
    return { apps, profilesRead: profiles.length, installedApps: installed.size, host: address, port: chosenPort }
  } finally {
    await link.close()
  }
}
