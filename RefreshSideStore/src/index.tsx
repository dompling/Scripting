import { Button, Color, ColorPicker, HStack, Image, Navigation, NavigationStack, Picker, ReorderableForEach, Script, Section, List, Text, TextField, useObservable, useState, Widget } from "scripting"
import { shortDate, type AppRecord, type AppSort } from "./model"
import { DEFAULT_BACKGROUNDS, normalizeBackground } from "./appearance"
import { getSettings, readWidgetState, saveRppApps, saveSettings, Settings, WidgetState } from "./runtime"
import { hasRppPairing, importRppPairingRecord, pairRppDevice, readExpiryViaRpp, rppHost, rppPort, saveRppHost, saveRppPort } from "./rpp-expiry"

function SettingsView({ initialState }: { initialState: WidgetState }) {
  const [settings, setSettings] = useState(getSettings)
  const [state, setState] = useState(initialState)
  function updateSettings(next: Settings) {
    saveSettings(next)
    setSettings(next)
    Widget.reloadAll()
  }

  async function setBackground(key: "lightBackground" | "darkBackground", value: Color) {
    try {
      const color = normalizeBackground(value)
      if (!color) throw new Error("无法读取所选颜色，请重新选择")
      updateSettings({ ...getSettings(), [key]: color })
    } catch (error) {
      await Dialog.alert({ title: "背景颜色", message: error instanceof Error ? error.message : "颜色保存失败" })
    }
  }

  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState(rppHost)
  const [port, setPort] = useState(rppPort)
  const dragActive = useObservable<any>(null)

  function setAppSort(sort: AppSort) {
    const next = { ...settings, appSort: sort }
    updateSettings(next)
    void readWidgetState(next).then(setState)
  }

  function moveApp(indices: number[], newOffset: number) {
    const apps = [...(state.apps ?? [])]
    const from = indices[0]
    if (from === undefined || from < 0 || from >= apps.length) return
    const [moved] = apps.splice(from, 1)
    const destination = Math.max(0, Math.min(newOffset > from ? newOffset - 1 : newOffset, apps.length))
    apps.splice(destination, 0, moved)
    const next = { ...settings, appSort: "manual" as const, appOrder: apps.map(app => app.bundleIdentifier) }
    updateSettings(next)
    setState({ ...state, apps, snapshot: apps.length > 0 ? { app: apps[0], readAt: state.snapshot?.readAt ?? Date.now(), source: "RPP / Misagent" } : undefined })
  }

  async function perform(task: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await task() } catch (error) {
      await Dialog.alert({ title: "SideStore 小组件", message: error instanceof Error ? error.message : "操作失败" })
    } finally { setBusy(false) }
  }

  async function importPairing(fromClipboard: boolean) {
    await perform(async () => {
      let content: string | Uint8Array
      if (fromClipboard) {
        const text = await Pasteboard.getString()
        if (!text?.trim()) throw new Error("剪贴板为空。请先复制配对记录的 XML 或 JSON 内容。")
        content = text
      } else {
        const paths = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"], allowsMultipleSelection: false })
        if (!paths?.length) return
        const raw: any = FileManager.readAsBytesSync(paths[0])
        content = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      }
      const result = await importRppPairingRecord(content)
      setState(await readWidgetState(settings))
      await Dialog.alert({ title: "导入成功", message: `已导入 ${result.name} 的配对记录，现在可以读取实际到期时间。` })
    })
  }

  return <NavigationStack>
    <List navigationTitle="SideStore 小组件" navigationBarTitleDisplayMode="inline">
      <Section>
        <Button title="预览小号组件" systemImage="square" disabled={busy} action={() => perform(async () => { await Widget.preview({ family: "systemSmall" }) })} />
        <Button title="预览中号组件" systemImage="rectangle" disabled={busy} action={() => perform(async () => { await Widget.preview({ family: "systemMedium" }) })} />
      </Section>

      <Section header={<Text>基础信息</Text>} footer={<Text>马蹄圈默认显示排序后的第一个 App。</Text>}>
        <Text font="headline">{state.snapshot?.app.name ?? "暂无扫描结果"}</Text>
        <Text foregroundStyle="secondaryLabel">{state.snapshot ? `到期 ${shortDate(state.snapshot.app.expiresAt)}` : "完成扫描后显示实际到期时间"}</Text>
        {state.snapshot ? <Text font="caption" foregroundStyle="secondaryLabel">上次扫描 {shortDate(state.snapshot.readAt)}</Text> : null}
        {state.error ? <Text font="caption" foregroundStyle="systemOrange">{state.error}</Text> : null}
        <Button title={busy ? "正在扫描…" : "扫描自签"} systemImage="antenna.radiowaves.left.and.right" disabled={busy} action={() => perform(async () => {
          // This is a user-facing reminder only: a VPN path might not expose its
          // underlying Wi-Fi interface. Never infer that RSD is reachable from
          // the interface list; the existing TCP/pair-verify probes decide that.
          try {
            const network = await Device.getNetworkState()
            if (network.status !== "satisfied" || !network.interfaces.includes("wifi")) {
              await Dialog.alert({
                title: "扫描前检查 Wi-Fi",
                message: "当前网络路径未检测到 Wi-Fi。建议先连接 Wi-Fi，并确认 Surge 隧道/反射可用后再扫描。若正在使用 VPN、蜂窝或其他网络，可关闭提示后继续尝试。",
              })
            }
          } catch {
            // Unavailable on some Scripting versions or contexts: scan normally.
          }
          const result = await readExpiryViaRpp(host, Number(port), () => {})
          saveRppApps(result.apps)
          setState(await readWidgetState(getSettings()))
          Widget.reloadAll()
          setPort(String(result.port))
          await Dialog.alert({ title: "扫描完成", message: `读取 ${result.profilesRead} 份描述文件；系统确认 ${result.installedApps} 个 App。\n已筛选出 ${result.apps.length} 个短期个人开发自签 App。\n使用端口：${result.port}` })
        })} />
        <Picker title="列表排序" value={settings.appSort} pickerStyle="segmented" onChanged={(value: unknown) => setAppSort(value === "manual" ? "manual" : value === "name" ? "name" : "expiry")}>
          <Text tag="manual">手动</Text>
          <Text tag="expiry">即将到期</Text>
          <Text tag="name">名称</Text>
        </Picker>
        <Text font="caption" foregroundStyle="secondaryLabel">选择“手动”后可拖动右侧手柄调整顺序；第一项即马蹄圈显示对象。</Text>
        <ReorderableForEach
          active={dragActive}
          data={(state.apps ?? []).map((app: AppRecord) => ({ id: app.bundleIdentifier, app }))}
          onMove={moveApp}
          builder={({ id, app }: { id: string, app: AppRecord }, index) => <HStack key={id} spacing={8}>
            <Image systemName={index === 0 ? "gauge.with.dots.needle.67percent" : "app.fill"} foregroundStyle={index === 0 ? "systemGreen" : "secondaryLabel"} />
            <Text font="subheadline" lineLimit={1}>{app.name}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{app.bundleIdentifier}</Text>
            <Text font="caption" foregroundStyle={app.expiresAt <= Date.now() ? "systemRed" : "secondaryLabel"}>{shortDate(app.expiresAt)}</Text>
            <Image systemName="line.3.horizontal" foregroundStyle="tertiaryLabel" />
          </HStack>}
        />
      </Section>

      <Section header={<Text>底部背景渐变</Text>}>
        <ColorPicker title="明亮模式渐变色" value={settings.lightBackground} supportsOpacity={false}
          onChanged={value => setBackground("lightBackground", value)} />
        <ColorPicker title="暗黑模式渐变色" value={settings.darkBackground} supportsOpacity={false}
          onChanged={value => setBackground("darkBackground", value)} />
        <Button title="恢复默认渐变" disabled={busy} action={() => perform(async () => {
          updateSettings({ ...getSettings(), lightBackground: DEFAULT_BACKGROUNDS.light, darkBackground: DEFAULT_BACKGROUNDS.dark })
        })} />
      </Section>

      <Section header={<Text>① 隧道连接</Text>} footer={<Text>RemotePairing 端口优先尝试下方填写的值；也会通过 Bonjour 发现，并自动回退尝试 62554 和 49152。</Text>}>
        <TextField title="设备反射 IP" value={host} prompt="10.7.0.1" onChanged={(value: string) => { setHost(value); saveRppHost(value) }} />
        <TextField title="RemotePairing 端口" value={port} prompt="62554" onChanged={(value: string) => { setPort(value); saveRppPort(value) }} />
      </Section>

      <Section header={<Text>② 设备配对</Text>} footer={<Text>新配对：点击“设备配对”，前往 iOS「设置 → 隐私与安全性 → 开发者模式 → 配对设备」，选择 RefreshSideStore，并按灵动岛显示的六位验证码输入。已有配对记录可从文件或剪贴板导入，无需再次配对。</Text>}>
        <HStack spacing={7}>
          <Image systemName={hasRppPairing() ? "checkmark.shield.fill" : "exclamationmark.shield.fill"}
            foregroundStyle={hasRppPairing() ? "systemGreen" : "systemRed"} />
          <Text foregroundStyle={hasRppPairing() ? "systemGreen" : "systemRed"} fontWeight="semibold">
            {hasRppPairing() ? "已有可用配对记录" : "尚未配对"}
          </Text>
        </HStack>
        <Button title={busy ? "正在配对…" : "设备配对（灵动岛验证码）"} systemImage="iphone.gen3" disabled={busy} action={() => perform(async () => {
          const paired = await pairRppDevice(() => {})
          await Dialog.alert({ title: "配对成功", message: `已配对 ${paired.name}，现在可以读取实际到期时间。` })
          setState(await readWidgetState(settings))
        })} />
        <Button title="从文件导入配对记录" systemImage="doc.badge.plus" disabled={busy} action={() => { void importPairing(false) }} />
        <Button title="从剪贴板导入配对记录" systemImage="doc.on.clipboard" disabled={busy} action={() => { void importPairing(true) }} />
      </Section>

    </List>
  </NavigationStack>
}

async function run() {
  const settings = getSettings()
  const action = Script.queryParameters.action
  if (action === "sidestore" || action === "livecontainer") {
    const url = action === "sidestore" ? settings.sideStoreURL : settings.liveContainerURL
    if (!await Safari.openURL(url)) await Dialog.alert({ title: "打开失败", message: "请检查客户端 URL 设置" })
    Script.exit()
    return
  }
  await Script.requestAccess(["fileSystem", "vpn", "localDevVPN"])
  await Navigation.present({ element: <SettingsView initialState={await readWidgetState(settings)} /> })
  Script.exit()
}
run()
