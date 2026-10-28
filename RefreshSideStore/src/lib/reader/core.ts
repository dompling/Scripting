/**
 * App Expiry Reader: read-only RPPairing -> RSD -> misagent.
 * IMPORTANT: never installs, removes, or refreshes provisioning profiles.
 * Pairing private keys stay in Scripting's per-script Storage; only parsed public
 * metadata is put in the widget cache.
 */
import { PairStore } from "../rpp/pairstore"
import { connectReader } from "./connection"
import { MisagentClient } from "../rsd/misagent"
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

function bundleFromAppId(full: string | null): string | null {
  if (!full) return null
  const match = /^([A-Z0-9]{10})\.(.+)$/.exec(full)
  const bundle = match ? match[2] : full
  return bundle === "*" || bundle.length === 0 ? null : bundle
}

export interface QueryOptions { host: string, preferredPort: number, log?: OnLog }

export async function queryExpiry(options: QueryOptions): Promise<Snapshot> {
  const log = options.log ?? (() => {})
  const { link, host, port: chosenPort } = await connectReader(options.host, options.preferredPort, log)
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
