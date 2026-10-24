import { Intent, Script, Widget } from "scripting"
import { getSettings, readWidgetState, saveRppApps } from "./runtime"
import { readExpiryViaRpp, rppHost, rppPort } from "./rpp-expiry"

async function run() {
  try {
    try { HapticFeedback.lightImpact() } catch {}
    // `readExpiryViaRpp` probes the preferred port first, discovers RemotePairing through Bonjour,
    // then falls back to 62554 and 49152 before reading Misagent and verifying installed apps.
    const result = await readExpiryViaRpp(rppHost(), Number(rppPort()))
    saveRppApps(result.apps)
    const state = await readWidgetState(getSettings())
    Widget.reloadAll()
    try { HapticFeedback.lightImpact() } catch {}
    Script.exit(Intent.json({
      ok: Boolean(state.snapshot) && !state.stale,
      estimated: false,
      expiresAt: state.snapshot ? new Date(state.snapshot.app.expiresAt).toISOString() : null,
      apps: result.apps.length,
      host: result.host,
      port: result.port,
      message: `已扫描 RemotePairing 端口并读取 ${result.apps.length} 个 App；小组件已刷新。`,
    }))
  } catch (error) {
    try { HapticFeedback.notificationWarning() } catch {}
    Script.exit(Intent.json({ ok: false, message: error instanceof Error ? error.message : "读取失败" }))
  }
}
run()
