/** Widget-safe cache helpers. No pairing, VPN, TCP, or device imports. */
export const CACHE_KEY = "expiry.reader.snapshot.v2"
export interface AppExpiry {
  bundleIdentifier: string
  applicationIdentifier: string
  name: string
  profileName: string | null
  teamId: string | null
  createdAt: string | null
  expiresAt: string | null
  remainingHoursAtCheck: number | null
  installed: boolean | null
  profileUUID?: string | null
  isShortTermDevelopment?: boolean
  profileValidityHours?: number | null
  getTaskAllow?: boolean
  isExtension?: boolean
}
export interface Snapshot {
  checkedAt: string
  host: string
  port: number
  allProfiles: number
  parsedProfiles: number
  installedVerified: true
  installedInventoryCount: number
  excludedUninstalledCount: number
  excludedExtensionCount: number
  matchedProfileCount: number
  apps: AppExpiry[]
  warnings: string[]
}
export function loadSnapshot(): Snapshot | null {
  try {
    const data = Storage.get<Snapshot>(CACHE_KEY)
    return data && data.installedVerified === true && Array.isArray(data.apps) &&
      data.apps.every(app => app.installed === true) && typeof data.checkedAt === "string" ? data : null
  } catch { return null }
}
export function remainingTime(expiresAt: string | null, now = new Date()): string {
  if (!expiresAt) return "未知有效期"
  const n = new Date(expiresAt).getTime() - now.getTime()
  if (!Number.isFinite(n)) return "日期异常"
  if (n <= 0) return "已到期"
  const hours = n / 3600000
  if (hours < 24) return `剩余 ${Math.ceil(hours)} 小时`
  return `剩余 ${Math.floor(hours / 24)} 天 ${Math.floor(hours % 24)} 小时`
}
export function dateText(iso: string | null): string {
  if (!iso) return "未知"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { hour12: false })
}
