export const APPLE_EPOCH_MS = 978307200000
export const DAY_MS = 86400000

export type AppRecord = {
  name: string
  bundleIdentifier: string
  expiresAt: number
  refreshedAt?: number
}

export type AppSort = "manual" | "expiry" | "name"

/** Stable ordering for the scanned self-signed App list and the widget's primary App. */
export function sortApps(apps: AppRecord[], sort: AppSort, manualOrder: string[] = []): AppRecord[] {
  const positions = new Map(manualOrder.map((identifier, index) => [identifier, index]))
  return [...apps].sort((a, b) => {
    if (sort === "manual") {
      const aPosition = positions.get(a.bundleIdentifier) ?? Number.MAX_SAFE_INTEGER
      const bPosition = positions.get(b.bundleIdentifier) ?? Number.MAX_SAFE_INTEGER
      if (aPosition !== bPosition) return aPosition - bPosition
    }
    const result = sort === "name"
      ? a.name.localeCompare(b.name, "zh-CN")
      : a.expiresAt - b.expiresAt || a.name.localeCompare(b.name, "zh-CN")
    return result || a.bundleIdentifier.localeCompare(b.bundleIdentifier)
  })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("数据格式不正确")
  }
  return value as Record<string, unknown>
}

export function appleDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("缺少有效的 Apple 日期")
  }
  const ms = value * 1000 + APPLE_EPOCH_MS
  if (ms < Date.UTC(2001, 0, 1) || ms > Date.UTC(2200, 0, 1)) {
    throw new Error("日期超出支持范围")
  }
  return ms
}

/** SideStore WidgetDataManager uses JSONEncoder's default Date strategy. */
export function parseWidgetData(text: string): AppRecord[] {
  const root = object(JSON.parse(text))
  if (!Array.isArray(root.activeApps)) {
    throw new Error("不是 SideStore widget_data.json：缺少 activeApps")
  }
  const apps = root.activeApps.map(value => {
    const app = object(value)
    if (typeof app.name !== "string" || typeof app.bundleIdentifier !== "string") {
      throw new Error("应用名称或标识缺失")
    }
    return {
      name: app.name,
      bundleIdentifier: app.bundleIdentifier,
      expiresAt: appleDate(app.expirationDate),
      refreshedAt: app.refreshedDate == null ? undefined : appleDate(app.refreshedDate),
    }
  })
  if (!apps.length) throw new Error("SideStore 没有导出活动应用，请先打开 SideStore")
  return apps
}

export function selectApp(apps: AppRecord[], identifier: string, sort: AppSort = "expiry", manualOrder: string[] = []): AppRecord {
  if (identifier) {
    const selected = apps.find(app => app.bundleIdentifier === identifier)
    if (!selected) throw new Error("未找到已选应用，请重新选择")
    return selected
  }
  // The horse-shoe defaults to the first entry in the saved scan ordering.
  return sortApps(apps, sort, manualOrder)[0]
}

export function countdown(expiresAt: number | undefined, now: number, totalDays: number) {
  if (expiresAt == null || !Number.isFinite(expiresAt)) {
    return { text: "—", unit: "", progress: 0, expired: false }
  }
  const remaining = Math.max(0, expiresAt - now)
  const days = remaining / DAY_MS
  // Round to 1 decimal place (e.g. >= 6.95 days rounds to 7.0, < 6.95 days rounds to 6.9).
  return {
    text: days >= 1 ? (Math.round(days * 10) / 10).toFixed(1) : remaining > 0 ? "<1" : "0",
    unit: "天",
    progress: Math.max(0, Math.min(1, days / Math.max(1, totalDays))),
    expired: expiresAt <= now,
  }
}

export function shortDate(ms?: number): string {
  if (ms == null) return "尚未配置"
  const d = new Date(ms)
  const p = (v: number) => String(v).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function shortTime(ms?: number): string {
  return ms == null ? "—" : shortDate(ms).slice(6)
}

export function shortcutURL(name: string): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name.trim() || "RefreshSideStore")}`
}

export function profileRecord(bytes: Uint8Array): AppRecord {
  // CMS signed .mobileprovision embeds an XML plist. Only read the date fields.
  let text = ""
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, i + 4096))
  }
  const start = text.indexOf("<plist")
  const end = text.indexOf("</plist>", start)
  if (start < 0 || end < 0) throw new Error("描述文件中没有 XML plist")
  const plist = text.slice(start, end)
  const date = (key: string) => {
    const result = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<date>([^<]+)</date>`).exec(plist)
    const ms = result ? Date.parse(result[1]) : NaN
    if (!Number.isFinite(ms)) throw new Error(`描述文件缺少 ${key}`)
    return ms
  }
  return {
    name: "SideStore",
    bundleIdentifier: "profile",
    expiresAt: date("ExpirationDate"),
    refreshedAt: date("CreationDate"),
  }
}
