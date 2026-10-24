import { Color } from "scripting"
import { AppRecord, AppSort, DAY_MS, selectApp, sortApps } from "./model"
import { DEFAULT_BACKGROUNDS, normalizeBackground } from "./appearance"

export type Source = { bookmark: string; relativePath: string; kind: "json" | "sqlite" | "profile"; displayPath?: string }
export type Settings = {
  shortcut: string
  tapAction: "refresh" | "sidestore" | "livecontainer"
  sideStoreURL: string
  liveContainerURL: string
  totalDays: number
  appIdentifier: string
  appSort: AppSort
  appOrder: string[]
  // Retain stored key names for compatibility; these colors only tint the lower background.
  lightBackground: Color
  darkBackground: Color
  manualExpiry?: number
  estimatedRefreshAt?: number
}
export type Snapshot = { app: AppRecord; readAt: number; source: string }
export type WidgetState = { snapshot?: Snapshot; apps?: AppRecord[]; stale: boolean; error?: string; manual: boolean; estimated?: boolean }

export function getSettings(): Settings {
  const saved = Storage.get<Partial<Settings>>("settings-v1")
  return {
    shortcut: "刷新证书",
    tapAction: "refresh",
    sideStoreURL: "sidestore://",
    liveContainerURL: "livecontainer://",
    totalDays: 7,
    appIdentifier: "",
    appSort: saved?.appSort === "manual" || saved?.appSort === "name" ? saved.appSort : "expiry",
    appOrder: Array.isArray(saved?.appOrder) ? saved.appOrder.filter((id): id is string => typeof id === "string") : [],
    ...saved,
    lightBackground: normalizeBackground(saved?.lightBackground ?? "") ?? DEFAULT_BACKGROUNDS.light,
    darkBackground: normalizeBackground(saved?.darkBackground ?? "") ?? DEFAULT_BACKGROUNDS.dark,
  }
}

export function saveSettings(settings: Settings, clearCache = false) {
  if (!Storage.set("settings-v1", settings)) throw new Error("设置保存失败")
  if (clearCache) Storage.remove("snapshot-v1")
}

/** Saves already-parsed, device-verified RPP profile expiries for the widget and app UI. */
export function saveRppApps(apps: AppRecord[]): void {
  if (!apps.length) throw new Error("RPP 未返回可显示的应用")
  const current = getSettings()
  const known = new Set(apps.map(app => app.bundleIdentifier))
  const retainedOrder = current.appOrder.filter(identifier => known.has(identifier))
  const appended = apps.map(app => app.bundleIdentifier).filter(identifier => !retainedOrder.includes(identifier))
  const appOrder = [...retainedOrder, ...appended]
  const ordered = sortApps(apps, current.appSort, appOrder)
  if (appOrder.join("\u0000") !== current.appOrder.join("\u0000")) saveSettings({ ...current, appOrder })
  const snapshot: Snapshot = { app: ordered[0], readAt: Date.now(), source: "RPP / Misagent" }
  if (!Storage.set("rpp-apps-v1", ordered) || !Storage.set("snapshot-v1", snapshot)) {
    throw new Error("RPP 到期数据保存失败")
  }
}

/** Reads the last successful RPP/Misagent profile query for the widget. */
export async function readWidgetState(settings: Settings): Promise<WidgetState> {
  const rppApps = Storage.get<AppRecord[]>("rpp-apps-v1")
  if (Array.isArray(rppApps) && rppApps.length > 0) {
    try {
      const apps = sortApps(rppApps, settings.appSort, settings.appOrder)
      const app = selectApp(apps, settings.appIdentifier, settings.appSort, settings.appOrder)
      const snapshot: Snapshot = { app, readAt: Storage.get<Snapshot>("snapshot-v1")?.readAt ?? Date.now(), source: "RPP / Misagent" }
      return { snapshot, apps, stale: false, manual: false }
    } catch { /* Fall through to the legacy source when the selected identifier changed. */ }
  }
  const cached = Storage.get<Snapshot>("snapshot-v1") ?? undefined
  return {
    snapshot: cached,
    stale: true,
    manual: false,
    error: "尚未通过 RPP 读取描述文件。请先完成设备配对，然后读取实际到期时间。",
  }
}
