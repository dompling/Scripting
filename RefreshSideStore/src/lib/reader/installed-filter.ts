/** Strict installed-only filter: exact OS Bundle ID, no prefix/fuzzy matching.
 * Caller must first get a SUCCESSFUL device installation list. Otherwise
 * refusing to publish a new snapshot is safer than treating profiles as installs.
 */
import type { PlistDict } from "../util/plist"
import type { AppExpiry } from "./cache"
import { isExtensionId } from "./filter"

export function filterInstalledProfiles(
  profiles: AppExpiry[], installed: Map<string, PlistDict>,
): { apps: AppExpiry[], excluded: number, matchedProfiles: number, extensionProfiles: number } {
  if (installed.size === 0) throw new Error("系统安装列表为空，拒绝根据历史描述文件发布结果")
  const confirmed: AppExpiry[] = []
  let excluded = 0, extensionProfiles = 0
  for (const entry of profiles) {
    // Extension provisioning profiles are not independent Home Screen apps.
    if (entry.isExtension || isExtensionId(entry.bundleIdentifier)) {
      extensionProfiles++
      continue
    }
    const meta = installed.get(entry.bundleIdentifier)
    if (!meta) { excluded++; continue }
    confirmed.push({ ...entry, installed: true, name: installedDisplayName(meta) ?? entry.profileName ?? entry.bundleIdentifier })
  }
  const byBundle = new Map<string, AppExpiry>()
  for (const entry of confirmed) {
    const old = byBundle.get(entry.bundleIdentifier)
    if (!old || isPreferredCandidate(entry, old)) byBundle.set(entry.bundleIdentifier, entry)
  }
  return {
    apps: Array.from(byBundle.values()).sort((a,b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? "")),
    excluded,
    matchedProfiles: confirmed.length,
    extensionProfiles,
  }
}

function installedDisplayName(info: PlistDict): string | null {
  for (const key of ["CFBundleDisplayName", "CFBundleName", "CFBundleExecutable"]) {
    const value = info[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function isPreferredCandidate(candidate: AppExpiry, current: AppExpiry): boolean {
  // Multiple profiles may remain for one installed app. Favor newest nonexpired
  // *created* profile, not the longest-lived profile. Still merely a candidate:
  // the exact in-use embedded.mobileprovision was not read.
  const now = Date.now()
  const valid = (app: AppExpiry): boolean => Boolean(app.expiresAt && Date.parse(app.expiresAt) > now)
  if (valid(candidate) !== valid(current)) return valid(candidate)
  const a = candidate.createdAt ? Date.parse(candidate.createdAt) : 0
  const b = current.createdAt ? Date.parse(current.createdAt) : 0
  if (a !== b) return a > b
  const aExpires = candidate.expiresAt ? Date.parse(candidate.expiresAt) : 0
  const bExpires = current.expiresAt ? Date.parse(current.expiresAt) : 0
  return aExpires > bExpires
}
