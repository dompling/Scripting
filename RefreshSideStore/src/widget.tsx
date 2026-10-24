import { Widget } from "scripting"
import { getSettings, readWidgetState } from "./runtime"
import { WidgetView } from "./view"
import { ShortcutDiagnostics } from "./shortcut_diagnostics"

async function run() {
  if (Widget.parameter === "debug-shortcut") {
    Widget.present(<ShortcutDiagnostics />)
    return
  }
  const settings = getSettings()
  // RPP scanning runs from the Shortcut intent; widgets only draw its last successful result.
  const state = await readWidgetState(settings)
  Widget.present(<WidgetView state={state} settings={settings} now={Date.now()}
    medium={Widget.family === "systemMedium"} />, {
    reloadPolicy: { policy: "after", date: new Date(Date.now() + 15 * 60 * 1000) },
  })
}
run()
