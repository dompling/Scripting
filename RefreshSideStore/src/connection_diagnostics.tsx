import { Button, HStack, Image, List, Navigation, NavigationStack, Section, Text, useState, VStack } from "scripting"
import { connectReader } from "./lib/reader/connection"
import { SERVICES } from "./lib/rsd/stream"
import { hasRppPairing, saveRppPort } from "./rpp-expiry"

interface CheckItem { label: string; detail: string; ok: boolean | null }

export function ConnectionDiagnostics({ host, port, scanLog = "" }: { host: string; port: number; scanLog?: string }) {
  const dismiss = Navigation.useDismiss()
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState<CheckItem[]>([])
  const [status, setStatus] = useState("点击“开始检测”，检查配对、隧道与设备服务。")
  const [logs, setLogs] = useState(scanLog)
  const [copyStatus, setCopyStatus] = useState("")

  async function run() {
    if (busy) return
    setBusy(true)
    setItems([])
    setCopyStatus("")
    const lines: string[] = []
    const checks: CheckItem[] = []
    function log(message: string) {
      lines.push(`${new Date().toISOString()} ${message}`)
      if (lines.length > 200) lines.shift()
      setLogs(lines.join("\n"))
      setStatus(message)
    }
    function add(label: string, detail: string, ok: boolean | null) {
      checks.push({ label, detail, ok })
      setItems([...checks])
    }
    try {
      log(`检测目标：${host.trim()}；首选端口：${port}`)
      try {
        const network = await Device.getNetworkState()
        add("网络路径", `${network.status}；接口：${network.interfaces.join("、") || "未知"}。以实际握手结果判断可用性。`, null)
      } catch { add("网络路径", "系统未提供网络状态，继续检查实际连接。", null) }
      const paired = hasRppPairing()
      add("配对记录", paired ? "已保存配对记录，接下来通过 pair-verify 验证。" : "没有配对记录，请返回完成配对或导入。", paired ? null : false)
      if (!paired) { log("缺少配对记录，检测结束。"); return }
      let connection: Awaited<ReturnType<typeof connectReader>> | null = null
      try {
        connection = await connectReader(host, port, log)
        add("配对验证与 RSD 隧道", `${connection.host}:${connection.port} 已通过配对验证和 RSD 握手。`, true)
        const services = connection.link.handshake.services
        add("描述文件服务", services.has(SERVICES.misagent) ? "Misagent 已在服务目录中。" : "设备未提供 Misagent 服务。", services.has(SERVICES.misagent))
        add("已安装 App 服务", services.has(SERVICES.installationProxy) ? "InstallationProxy 已在服务目录中。" : "设备未提供 InstallationProxy 服务。", services.has(SERVICES.installationProxy))
        saveRppPort(String(connection.port))
        log(checks.some(item => item.ok === false) ? "RSD 已连接，但缺少扫描所需的服务，详见检测结果。" : "连接检测通过，已保存可用端口。返回后可扫描自签。")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        add("配对验证与 RSD 隧道", message, false)
        log(`检测失败：${message}`)
      } finally { await connection?.link.close() }
    } catch (error) {
      log(`检测异常：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  return <NavigationStack interactiveDismissDisabled={busy}>
    <List navigationTitle="连接检测" navigationBarTitleDisplayMode="inline" toolbar={{
      cancellationAction: <Button title="关闭" disabled={busy} action={() => dismiss()} />,
    }}>
      <Section header={<Text>检测目标</Text>} footer={<Text>沿用扫描自签的连接流程，验证配对并读取 RSD 服务目录。检测结束会关闭本次连接；不会改写描述文件或扫描缓存。</Text>}>
        <Text>设备反射 IP：{host}</Text>
        <Text>首选端口：{port}</Text>
        <Button title={busy ? "正在检测…" : items.length ? "重新检测" : "开始检测"} systemImage="stethoscope" disabled={busy} action={() => void run()} />
        <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>
      </Section>
      {items.length ? <Section header={<Text>检测结果</Text>}>
        {items.map(item => <HStack key={item.label} spacing={10}>
          <Image systemName={item.ok === null ? "info.circle" : item.ok ? "checkmark.circle.fill" : "xmark.circle.fill"}
            foregroundStyle={item.ok === null ? "secondaryLabel" : item.ok ? "systemGreen" : "systemRed"} />
          <VStack alignment="leading" spacing={4}>
            <Text font="subheadline">{item.label}</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">{item.detail}</Text>
          </VStack>
        </HStack>)}
      </Section> : null}
      <Section header={<Text>检测日志</Text>} footer={<Text>保留最近 200 条，仅在本次页面中保存。日志包含目标 IP、端口和错误原因，不记录配对密钥。</Text>}>
        <Button title="复制日志" systemImage="doc.on.doc" disabled={!logs || busy} action={async () => {
          try { await Pasteboard.setString(logs); setCopyStatus("日志已复制") }
          catch (error) { setCopyStatus(`复制失败：${error instanceof Error ? error.message : String(error)}`) }
        }} />
        {copyStatus ? <Text font="caption" foregroundStyle="secondaryLabel">{copyStatus}</Text> : null}
        <Text font="caption2" fontDesign="monospaced" foregroundStyle="secondaryLabel">{logs || "尚无日志"}</Text>
      </Section>
      <Section header={<Text>连接提示</Text>}>
        <Text font="caption">使用 Surge 等代理时，设备反射 IP 需要与代理的 loopback-address 配置一致。检测只启用 LocalDevVPN 功能开关，不会替换当前 VPN。</Text>
        <Text font="caption">ECONNREFUSED 表示目标端口拒绝连接；ETIMEDOUT 表示连接未在期限内建立。检测会继续查找动态端口，最终以配对与 RSD 握手结果为准。</Text>
        <Text font="caption">系统更新后若 pair-verify 失败，请返回重新配对。RSD 目录可用仍需通过“扫描自签”确认描述文件和当前安装列表能实际读取。</Text>
      </Section>
    </List>
  </NavigationStack>
}
