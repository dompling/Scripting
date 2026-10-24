/** Read-only installed application enumeration through installation_proxy.
 * Misagent's CopyAll returns installed *profiles*, including stale profiles left by
 * removed apps. This module obtains the CURRENT OS installation inventory.
 * No Install / Uninstall / Archive operations are ever sent.
 */
import type { DeviceLink } from "./device"
import { PlistStream, rsdCheckin, SERVICES } from "./stream"
import type { PlistDict } from "../util/plist"

export type InstalledAppMap = Map<string, PlistDict>
type Logger = (message: string) => void

function errorText(reply: PlistDict): string | null {
  const err = reply.Error ?? reply.ErrorDescription
  return err == null ? null : String(err)
}

function acceptedAppInfo(value: unknown): value is PlistDict {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function collectDictEntries(dict: PlistDict, result: InstalledAppMap): void {
  for (const [key, value] of Object.entries(dict)) {
    if (!acceptedAppInfo(value)) continue
    const bundle = typeof value.CFBundleIdentifier === "string" && value.CFBundleIdentifier.trim()
      ? value.CFBundleIdentifier.trim() : key
    if (bundle) result.set(bundle, value)
  }
}

async function lookupAll(link: DeviceLink): Promise<InstalledAppMap> {
  const stream = await link.open(SERVICES.installationProxy)
  try {
    await rsdCheckin(stream, "AppExpiryReader-installed-lookup")
    const plists = new PlistStream(stream)
    // Only ask for User installed apps and minimal attributes to keep Lookup payload compact.
    await plists.send({
      Command: "Lookup",
      ClientOptions: {
        ApplicationType: "User",
        ReturnAttributes: ["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName", "CFBundleExecutable", "ApplicationType"],
      },
    })
    const result = new Map<string, PlistDict>()
    for (let i = 0; i < 5; i++) {
      const reply = await plists.receive()
      if (!reply) throw new Error("Lookup 无返回数据")
      const error = errorText(reply)
      if (error) throw new Error(`Lookup 服务返回错误：${error}`)
      if (acceptedAppInfo(reply.LookupResult)) collectDictEntries(reply.LookupResult, result)
      if (reply.Status === "Complete") break
      if (reply.LookupResult) break
    }
    if (result.size === 0) throw new Error("Lookup 返回空安装列表")
    return result
  } finally {
    try { await stream.close?.() } catch { /* best-effort */ }
  }
}

async function browseAll(link: DeviceLink): Promise<InstalledAppMap> {
  const stream = await link.open(SERVICES.installationProxy)
  try {
    await rsdCheckin(stream, "AppExpiryReader-installed-browse")
    const plists = new PlistStream(stream)
    await plists.send({
      Command: "Browse", ClientOptions: {
        ApplicationType: "Any",
        ReturnAttributes: ["CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName", "CFBundleShortVersionString", "CFBundleVersion", "ApplicationType"],
      },
    })
    const result = new Map<string, PlistDict>()
    let completed = false
    // Browse streams CurrentList in one or more batches, then Status: Complete.
    for (let i = 0; i < 128; i++) {
      const reply = await plists.receive()
      if (!reply) throw new Error("Browse 在 Complete 前断开")
      const error = errorText(reply)
      if (error) throw new Error(`Browse 服务返回错误：${error}`)
      const list = reply.CurrentList
      if (Array.isArray(list)) {
        for (const row of list) {
          if (!acceptedAppInfo(row)) continue
          const id = row.CFBundleIdentifier
          if (typeof id === "string" && id.trim()) result.set(id.trim(), row)
        }
      }
      if (reply.Status === "Complete") { completed = true; break }
    }
    if (!completed) throw new Error("Browse 没有返回完成标记")
    if (result.size === 0) throw new Error("Browse 返回空安装列表")
    return result
  } finally {
    try { await stream.close?.() } catch { /* best-effort */ }
  }
}

export async function listInstalledApps(link: DeviceLink, log: Logger): Promise<InstalledAppMap> {
  try {
    const result = await lookupAll(link)
    log(`InstallationProxy Lookup：确认系统当前安装 ${result.size} 个 App`)
    return result
  } catch (error) {
    log(`InstallationProxy Lookup 不可用，尝试 Browse：${error instanceof Error ? error.message : String(error)}`)
  }
  const result = await browseAll(link)
  log(`InstallationProxy Browse：确认系统当前安装 ${result.size} 个 App`)
  return result
}
