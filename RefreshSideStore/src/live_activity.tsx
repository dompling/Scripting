/** Dynamic Island pairing surface, adapted from the user's SideInstaller.scripting.
 * All text is pre-rendered in the app process. The extension never performs pairing.
 */
import {
  AppEvents, LiveActivity, LiveActivityUI, LiveActivityUIExpandedCenter, Text, VStack,
  type LiveActivityUIBuilder, type ScenePhase,
} from "scripting"

export interface CodeState {
  pin: string
  title: string
  hint: string
  tone: "waiting" | "ok" | "failed"
}
const COLOR = { waiting: "#0A84FF", ok: "#30D158", failed: "#FF453A" } as const

function PairCode({ state, size }: { state: CodeState, size: number }) {
  return (
    <VStack spacing={2} frame={{ maxWidth: "infinity" }}>
      <Text font="caption2" foregroundStyle="secondaryLabel">{state.title}</Text>
      <Text font={{ name: "Menlo", size }} foregroundStyle={COLOR[state.tone]}>{state.pin}</Text>
      <Text font="caption2" foregroundStyle="secondaryLabel">{state.hint}</Text>
    </VStack>
  )
}

const builder: LiveActivityUIBuilder<CodeState> = state => (
  <LiveActivityUI
    content={<PairCode state={state} size={34} />}
    compactLeading={<Text font={{ name: "Menlo", size: 15 }}>{state.pin.slice(0, 3)}</Text>}
    compactTrailing={<Text font={{ name: "Menlo", size: 15 }}>{state.pin.slice(3)}</Text>}
    minimal={<Text font={{ name: "Menlo", size: 13 }}>{state.pin.slice(0, 3)}</Text>}>
    <LiveActivityUIExpandedCenter>
      <PairCode state={state} size={26} />
    </LiveActivityUIExpandedCenter>
  </LiveActivityUI>
)

export const PairingActivity = LiveActivity.register("AppExpiryReaderPairing", builder)

export interface PairingSurface {
  start(pin: string): Promise<string | null>
  prompt(pin: string): Promise<void>
  finish(success: boolean, name: string): Promise<void>
}

export function createPairingSurface(): PairingSurface {
  let activity: ReturnType<typeof PairingActivity> | null = null
  let pin = ""
  let inFront = true
  const phaseListener = (phase: ScenePhase) => { inFront = phase === "active" }
  AppEvents.scenePhase.addListener(phaseListener)
  const state = (title: string, hint: string, tone: CodeState["tone"]): CodeState =>
    ({ pin, title, hint, tone })

  const update = async (data: CodeState, notify = false) => {
    if (!activity) return
    try {
      await activity.update(data, notify ? { alert: { title: data.title, body: data.hint } } : undefined)
    } catch { /* Best effort: PIN also appears in the main script view / console. */ }
  }
  return {
    async start(code) {
      pin = code
      try {
        if (!await LiveActivity.areActivitiesEnabled()) return "未开启实时活动，配对码仍在脚本日志中显示"
        const instance = PairingActivity()
        const ok = await instance.start(state("设备配对", "设置 → 隐私与安全性 → 开发者模式", "waiting"))
        if (!ok) return "系统拒绝启动实时活动；请看脚本日志中的配对码"
        activity = instance
        return null
      } catch (error) {
        return `实时活动启动失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
    async prompt(code) {
      if (code) pin = code
      await update(state("输入配对码", "在系统配对提示框中输入这六位数字", "waiting"), true)
    },
    async finish(success, name) {
      if (!activity) { AppEvents.scenePhase.removeListener(phaseListener); return }
      const endState = success
        ? state("配对成功", `已配对 ${name || "iPhone"}，返回 Scripting 读取签名`, "ok")
        : state("配对未完成", "返回 Scripting 重试或导入原配对文件", "failed")
      await update(endState, true)
      try {
        // If the user is still in Settings, keep the success status briefly as SideInstaller does.
        // An explicit deadline keeps the script from remaining alive indefinitely.
        if (success && !inFront) {
          await new Promise<void>(resolve => {
            let timer: ReturnType<typeof setTimeout> | null = null
            const listener = (phase: ScenePhase) => {
              if (phase === "active") { if (timer !== null) clearTimeout(timer); AppEvents.scenePhase.removeListener(listener); resolve() }
            }
            timer = setTimeout(() => { AppEvents.scenePhase.removeListener(listener); resolve() }, 12000)
            AppEvents.scenePhase.addListener(listener)
          })
          await activity.end(endState, { dismissTimeInterval: 0 })
        } else {
          await activity.end(endState, { dismissTimeInterval: 60 })
        }
      } catch { /* End failures must not invalidate a finished pairing. */ }
      activity = null
      AppEvents.scenePhase.removeListener(phaseListener)
    },
  }
}
