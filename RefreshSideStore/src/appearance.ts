import type { Color, LinearGradient } from "scripting"

export const DEFAULT_BACKGROUNDS = { light: "#FFFFFF", dark: "#1C1C1E" } as const

export function normalizeBackground(value: unknown): Color | undefined {
  if (typeof value !== "string") return undefined
  const hex = value.trim().replace(/^#/, "")
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const upper = hex.toUpperCase()
    // 纠正 iOS 原生取色器因浮点取整误差把 1C1C1E 歪成 1B1B1D 的问题
    if (upper === "1B1B1D") return "#1C1C1E"
    return `#${upper}`
  }
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${hex.split("").map(char => char + char).join("").toUpperCase()}`
  // The native picker can return RGB(A); backgrounds stay opaque with supportsOpacity=false.
  const rgb = /^rgb(a)?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(value.trim())
  if (rgb && Boolean(rgb[1]) === (rgb[5] != null)) {
    const channels = rgb.slice(2, 5).map(Number)
    const alpha = rgb[5] == null ? 1 : Number(rgb[5])
    if (channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1) {
      const hexStr = channels.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("").toUpperCase()
      if (hexStr === "1B1B1D") return "#1C1C1E"
      return `#${hexStr}`
    }
  }
  return undefined
}

/** Keep the upper background unchanged; fade the selected tint into the lower 45% only. */
export function backgroundGradient(value: string, baseColor: string): LinearGradient {
  const base = normalizeBackground(baseColor) ?? DEFAULT_BACKGROUNDS.light
  const tint = normalizeBackground(value) ?? base
  const channels = [1, 3, 5].map(start => parseInt(base.slice(start, start + 2), 16))
  const bottom: Color = `#${channels.map((channel, index) => {
    const selected = parseInt(tint.slice(1 + index * 2, 3 + index * 2), 16)
    const mixed = tint === base ? Math.max(0, channel - 5) : Math.round(channel * 0.76 + selected * 0.24)
    return mixed.toString(16).padStart(2, "0")
  }).join("").toUpperCase()}`
  return {
    stops: [{ color: base, location: 0 }, { color: base, location: 0.55 }, { color: bottom, location: 1 }],
    startPoint: "top",
    endPoint: "bottom",
  }
}
