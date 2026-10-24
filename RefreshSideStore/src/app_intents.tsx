import { AppIntentManager, AppIntentProtocol, Widget } from "scripting"

const TAP_COUNT_KEY = "shortcut-diagnostic-taps-v1"

export function diagnosticTapCount(): number {
  const count = Storage.get<number>(TAP_COUNT_KEY)
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export const DiagnosticTapIntent = AppIntentManager.register({
  name: "DiagnosticTapIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_: undefined) => {
    if (!Storage.set(TAP_COUNT_KEY, diagnosticTapCount() + 1)) throw new Error("诊断计数保存失败")
    Widget.reloadAll()
  },
})
