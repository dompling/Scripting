/** Classification for personal 7-day development provisioning profiles.
 * This is NOT an Apple account type check or active code-signature verification.
 */
import type { AppExpiry } from "./cache"

export interface DevEvidence {
  createdAt: string | null
  expiresAt: string | null
  getTaskAllow: boolean
  hasProvisionedDevices: boolean
  provisionsAllDevices: boolean
}
export function isShortTermDevelopmentProfile(profile: DevEvidence): boolean {
  if (!profile.getTaskAllow || !profile.hasProvisionedDevices || profile.provisionsAllDevices) return false
  if (!profile.createdAt || !profile.expiresAt) return false
  const length = Date.parse(profile.expiresAt) - Date.parse(profile.createdAt)
  return Number.isFinite(length) && length > 0 && length <= 14 * 86400000
}

const EXTENSION_SUFFIXES = [
  ".LiveWidget", ".LiveProcess", ".ShareExtension", ".LaunchAppExtension",
  ".Widget", ".WidgetExtension", ".PacketTunnel", ".KeyboardExtension",
  ".NotificationExtension", ".Intents", ".Shortcuts", ".FileProvider",
  ".SafariWebExtension", ".TranslationUIExtension", ".PushServiceExtension",
  ".NativeAssetProbeDownloader", ".PythonScriptActivityWidget", ".WidgetIntentExtension",
]
export function isExtensionId(bundle: string): boolean {
  return EXTENSION_SUFFIXES.some(suffix => bundle.endsWith(suffix))
}
export function shortTermDevelopmentProfiles(apps: AppExpiry[]): AppExpiry[] {
  return apps.filter(a => a.installed === true && a.isShortTermDevelopment === true)
}
export function primaryShortTermApps(apps: AppExpiry[]): AppExpiry[] {
  return shortTermDevelopmentProfiles(apps).filter(a => !a.isExtension && !isExtensionId(a.bundleIdentifier))
    .sort((a,b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""))
}
