/**
 * App Expiry Reader: read-only RPPairing -> RSD -> misagent.
 * IMPORTANT: never installs, removes, or refreshes provisioning profiles.
 * Pairing private keys stay in Scripting's per-script Storage; only parsed public
 * metadata is put in the widget cache.
 */
import { PairStore } from "../rpp/pairstore"
import { openDeviceLink, type DeviceLink } from "../rsd/device"
import { MisagentClient } from "../rsd/misagent"
import { probeTcp } from "../rsd/probe"
import { SERVICES } from "../rsd/stream"
import { listInstalledApps } from "../rsd/installed-apps"
import { filterInstalledProfiles } from "./installed-filter"
import { parseProvisioningProfile } from "../sign/provisioning"
import { isShortTermDevelopmentProfile, isExtensionId } from "./filter"

export { CACHE_KEY, loadSnapshot, dateText, remainingTime } from "./cache"
import { CACHE_KEY, type AppExpiry, type Snapshot } from "./cache"
export type { AppExpiry, Snapshot } from "./cache"

export const HOST_KEY = "expiry.reader.device.host.v1"
export const PORT_KEY = "expiry.reader.device.port.v1"
export const MODE_KEY = "expiry.reader.vpn.mode.v1"

export type OnLog = (message: string) => void

export function isPaired(): boolean { return new PairStore().hasDeviceIrk() }

export async function importPairingRecord(input: string | Uint8Array): Promise<{name:string,udid:string}> {
  return new PairStore().importRecord(input)
}

function normalizeHost(raw: string): string {
  const host = (raw || "").trim()
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p)>255)) {
    throw new Error(`IP 地址格式错误：${raw}`)
  }
  return host
}

/** Best effort Bonjour discovery, without relying on it for success. */
async function discoverBonjourPorts(log: OnLog, timeoutMs = 1400): Promise<number[]> {
  const Bonjour: any = (globalThis as any).Bonjour
  if (!Bonjour || typeof Bonjour.browse !== "function") return []
  const ports = new Set<number>()
  let browser: any = null
  let finish = () => {}
  const finished = new Promise<void>(resolve => { finish = resolve })
  // Timer is armed outside a Bonjour callback per Scripting's runtime constraints.
  const timer = setTimeout(() => finish(), timeoutMs)
  try {
    browser = Bonjour.browse({
      type: "_remotepairing._tcp",
      includePeerToPeer: true,
      onFound: (service: any) => {
        const port = Number(service?.port)
        if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port)
      },
      onError: () => finish(),
    })
    await finished
  } catch (error) {
    log(`Bonjour 探测不可用：${String(error)}`)
  } finally {
    clearTimeout(timer)
    try { browser?.stop?.() } catch { /* already closed */ }
  }
  return Array.from(ports)
}

function isNumericPort(n: number): boolean { return Number.isInteger(n) && n > 0 && n <= 65535 }

async function candidatePorts(host: string, preferred: number, log: OnLog): Promise<number[]> {
  const bonjour = await discoverBonjourPorts(log)
  const candidates = Array.from(new Set([preferred, ...bonjour, 62554, 49152].filter(isNumericPort)))
  log(`候选端口：${candidates.join(", ")}`)
  return candidates
}

function bundleFromAppId(full: string | null): string | null {
  if (!full) return null
  const match = /^([A-Z0-9]{10})\.(.+)$/.exec(full)
  const bundle = match ? match[2] : full
  return bundle === "*" || bundle.length === 0 ? null : bundle
}

export interface QueryOptions { host: string, preferredPort: number, log?: OnLog }

export async function queryExpiry(options: QueryOptions): Promise<Snapshot> {
  const log = options.log ?? (() => {})
  const host = normalizeHost(options.host)
  const pair = new PairStore()
  if (!pair.hasDeviceIrk()) throw new Error("没有配对记录。请先从 SideInstaller 导出并导入配对文件。")
  const preferredPort = isNumericPort(options.preferredPort) ? options.preferredPort : 62554
  const ports = await candidatePorts(host, preferredPort, log)
  let link: DeviceLink | null = null
  let chosenPort = 0
  const failures: string[] = []
  for (const port of ports) {
    const probe = await probeTcp(host, port, 1800)
    if (!probe.open) {
      log(`${host}:${port} 不可达 (${probe.code ?? "未知"})`)
      failures.push(`${port}: ${probe.code}`)
      continue
    }
    log(`${host}:${port} 可连接，正在 pair-verify…`)
    try {
      link = await openDeviceLink({ address: host, remotedPort: port, stepTimeoutMs: 11000, onStep: log })
      chosenPort = port
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${port}: ${message}`)
      log(`端口 ${port} 建立隧道失败：${message}`)
    }
  }
  if (!link) throw new Error(`未能建立只读 RSD 会话。${failures.join("；").slice(0, 1200)}`)
  try {
    log("隧道已建立，正在读取系统描述文件…")
    const client = await MisagentClient.connect(await link.open(SERVICES.misagent), "AppExpiryReader-readonly")
    let rawProfiles: Uint8Array[]
    try { rawProfiles = await client.copyAll() } finally { await client.disconnect() }
    log(`Misagent CopyAll 成功：${rawProfiles.length} 份描述文件`)
    const warnings: string[] = []
    const profiles: AppExpiry[] = []
    const now = Date.now()
    for (let i=0;i<rawProfiles.length;i++) {
      try {
        const profile = parseProvisioningProfile(rawProfiles[i])
        const id = profile.applicationIdentifier
        const bundle = bundleFromAppId(id)
        if (!bundle) {
          warnings.push(`描述文件 ${i + 1} 是通配符或没有 App ID，已跳过`)
          continue
        }
        const created = profile.plist.CreationDate instanceof Date ? profile.plist.CreationDate.toISOString() : null
        const expires = profile.expirationDate?.toISOString() ?? null
        const profileValidityHours = created && expires ?
          (Date.parse(expires) - Date.parse(created)) / 3600000 : null
        const getTaskAllow = profile.entitlements["get-task-allow"] === true
        const isShortTermDevelopment = isShortTermDevelopmentProfile({
          expiresAt: expires, createdAt: created, getTaskAllow,
          hasProvisionedDevices: profile.provisionedDevices !== null,
          provisionsAllDevices: profile.plist.ProvisionsAllDevices === true,
        })
        profiles.push({
          bundleIdentifier: bundle,
          applicationIdentifier: id!,
          name: bundle,
          profileName: profile.name,
          teamId: profile.teamIdentifier,
          createdAt: created,
          expiresAt: expires,
          remainingHoursAtCheck: expires ? Math.max(0, (new Date(expires).getTime() - now) / 3600000) : null,
          installed: null,
          profileUUID: profile.uuid,
          profileValidityHours,
          getTaskAllow,
          isShortTermDevelopment,
          isExtension: isExtensionId(bundle),
        })
      } catch (error) {
        warnings.push(`描述文件 ${i+1} 解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // This step is mandatory: Misagent includes stale/uninstalled profiles.
    // If InstallationProxy cannot enumerate the current OS inventory, abort;
    // the previous verified cache remains intact.
    let installedApps
    try {
      installedApps = await listInstalledApps(link, log)
    } catch (error) {
      throw new Error(`无法确认系统实际安装 App，未更新缓存：${error instanceof Error ? error.message : String(error)}`)
    }
    const filtered = filterInstalledProfiles(profiles, installedApps)
    log(`按系统安装状态过滤：匹配 ${filtered.matchedProfiles} 份描述文件，合并为 ${filtered.apps.length} 个主 App；排除未安装 ${filtered.excluded} 份、扩展 ${filtered.extensionProfiles} 份`)
    if (filtered.apps.length === 0 && profiles.length > 0) {
      throw new Error(`Misagent 解析 ${profiles.length} 份有效资料，但与当前安装列表没有精确 Bundle ID 匹配；可能存在 SideStore 重签 ID 差异。为避免误报未更新缓存，请导出诊断日志核对。`)
    }
    if (filtered.excluded > 0) warnings.push(`已过滤 ${filtered.excluded} 份系统没有对应安装项的旧/未安装描述文件`)
    const snapshot: Snapshot = {
      checkedAt: new Date().toISOString(), host, port: chosenPort,
      allProfiles: rawProfiles.length, parsedProfiles: profiles.length,
      installedInventoryCount: installedApps.size, excludedUninstalledCount: filtered.excluded,
      matchedProfileCount: filtered.matchedProfiles, excludedExtensionCount: filtered.extensionProfiles,
      installedVerified: true, apps: filtered.apps, warnings,
    }
    Storage.set(CACHE_KEY, snapshot)
    Storage.set(PORT_KEY, String(chosenPort))
    log(`完成：${filtered.apps.length} 个经系统安装状态确认的主 App，已写入隔离版缓存`)
    return snapshot
  } finally {
    await link.close()
  }
}
