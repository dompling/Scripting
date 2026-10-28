// Shared by scans and diagnostics: a refused default port is not proof that the tunnel is down.
import { PairStore } from "../rpp/pairstore"
import { validateAuthTag } from "../rpp/siphash"
import { fromUtf8 } from "../util/bytes"
import { openDeviceLink, type DeviceLink } from "../rsd/device"
import { probeTcp } from "../rsd/probe"

export type ConnectionLog = (message: string) => void
export interface ReaderConnection { link: DeviceLink; host: string; port: number }
const SCAN_START = 49152
const SCAN_END = 51200
const SCAN_BATCH = 64

export function reflectedIPv4(raw: string): string {
  const host = raw.trim()
  const parts = host.split(".")
  const normalized = parts.map(Number).join(".")
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255) ||
      Number(parts[0]) === 127 || normalized === "0.0.0.0") {
    throw new Error("设备反射 IP 必须是有效的数字 IPv4 地址（例如 10.7.0.1），不能使用本机回环地址。")
  }
  return normalized
}

function validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535 }

/** browse reports service identities; only resolve provides ports/TXT records. */
async function bonjourPorts(deviceIrk: Uint8Array | null, log: ConnectionLog): Promise<number[]> {
  const api = (globalThis as any).Bonjour
  if (!api?.browse || !api?.resolve) { log("Bonjour 不可用，使用端口扫描"); return [] }
  const ports = new Set<number>()
  const resolving = new Set<string>()
  let browser: any = null
  let ended = false
  let finish = () => {}
  const complete = new Promise<void>(resolve => { finish = resolve })
  const timer = setTimeout(finish, 1800)
  try {
    browser = api.browse({
      type: "_remotepairing._tcp", includePeerToPeer: true,
      onFound: (service: { name: string }) => {
        if (ended || resolving.has(service.name) || resolving.size >= 16) return
        resolving.add(service.name)
        void api.resolve(service, { timeout: 1400, includePeerToPeer: true }).then((result: any) => {
          if (ended || !validPort(result.port)) return
          const txt = result.txtRecord ?? {}
          const text = (value: unknown) => typeof value === "string" ? value : value instanceof Uint8Array ? fromUtf8(value) : ""
          const tag = text(txt.authTag)
          if (tag && deviceIrk) {
            try {
              if (!validateAuthTag(deviceIrk, text(txt.identifier) || service.name, tag)) {
                log("跳过身份不匹配的 Bonjour 配对服务")
                return
              }
            } catch { return }
          }
          // The reflected host stays fixed; every candidate still has to pass pair-verify.
          ports.add(result.port)
          log(`Bonjour 解析到配对端口：${result.port}`)
        }).catch(() => {})
      },
      onError: () => finish(),
    })
    await complete
  } catch (error) {
    log(`Bonjour 发现失败，继续扫描：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    ended = true
    clearTimeout(timer)
    try { browser?.stop() } catch {}
  }
  return Array.from(ports)
}

/** External VPN owns the route. Enabling LocalDevVPN must not start/replace that VPN. */
export async function prepareReaderVPN(log: ConnectionLog): Promise<void> {
  const api = (globalThis as any).VPN?.localDevVPN
  if (!api?.getState) { log("无法读取 LocalDevVPN 状态，继续验证实际连接"); return }
  try {
    const state = await api.getState()
    log(`LocalDevVPN：${state.effectiveStatus ?? "未知"}；Scripting VPN：${state.vpnStatus ?? "未知"}`)
    if (!state.enabled) {
      await api.setEnabled(true, { expectedState: state.expectedState })
      log("已启用 LocalDevVPN 功能开关（保留当前 VPN 路由）")
    }
  } catch (error) {
    // A concurrent VPN configuration change must not block an otherwise usable proxy route.
    log(`LocalDevVPN 状态检查未完成，继续验证实际连接：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function connectReader(host: string, preferredPort: number, log: ConnectionLog = () => {}): Promise<ReaderConnection> {
  const address = reflectedIPv4(host)
  const pair = new PairStore()
  if (!pair.hasDeviceIrk()) throw new Error("没有 RPP 配对记录。请先完成设备配对，或从文件/剪贴板导入已有配对记录。")
  await prepareReaderVPN(log)
  const tried = new Set<number>()
  const failures: string[] = []
  const codes = new Map<string, number>()
  let reachable = 0

  async function attempt(port: number, probe = true): Promise<ReaderConnection | null> {
    if (tried.has(port)) return null
    tried.add(port)
    if (probe) {
      const result = await probeTcp(address, port, 1200)
      if (!result.open) {
        const code = result.code ?? "UNKNOWN"
        codes.set(code, (codes.get(code) ?? 0) + 1)
        log(`${address}:${port} 不可达（${code}）`)
        return null
      }
    }
    reachable++
    log(`${address}:${port} 可连接，校验配对记录并建立 RSD 隧道…`)
    try {
      const link = await openDeviceLink({ address, remotedPort: port, stepTimeoutMs: 11000, onStep: log })
      log(`RSD 连接成功：${link.handshake.services.size} 项服务`)
      return { link, host: address, port }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${port}: ${message}`)
      log(`端口 ${port} 握手失败：${message}`)
      return null
    }
  }

  const quick = Array.from(new Set([preferredPort, 62554, 49152].filter(validPort)))
  log(`快速候选端口：${quick.join(", ")}`)
  for (const port of quick) { const result = await attempt(port); if (result) return result }

  log("快速端口不可用，正在解析 Bonjour 配对服务…")
  const discovered = await bonjourPorts(pair.load()?.deviceAltIrk ?? null, log)
  for (const port of discovered) { const result = await attempt(port); if (result) return result }

  log(`候选端口未连接，扫描 ${address}:${SCAN_START}–${SCAN_END}…`)
  const open: number[] = []
  for (let base = SCAN_START; base <= SCAN_END; base += SCAN_BATCH) {
    const batch: Promise<void>[] = []
    for (let port = base; port < base + SCAN_BATCH && port <= SCAN_END; port++) {
      if (tried.has(port)) continue
      batch.push(probeTcp(address, port, 250).then(result => {
        if (result.open) open.push(port)
        else {
          tried.add(port)
          const code = result.code ?? "UNKNOWN"
          codes.set(code, (codes.get(code) ?? 0) + 1)
        }
      }))
    }
    await Promise.all(batch)
    if ((base - SCAN_START) % (SCAN_BATCH * 8) === 0) log(`端口扫描进度：${Math.min(base + SCAN_BATCH - 1, SCAN_END) - SCAN_START + 1}/${SCAN_END - SCAN_START + 1}`)
  }
  log(`扫描完成，发现开放端口：${open.join(", ") || "无"}`)
  for (const port of open.sort((a, b) => a - b)) { const result = await attempt(port, false); if (result) return result }

  const summary = Array.from(codes, ([code, count]) => `${code} × ${count}`).join("；")
  const advice = reachable > 0
    ? "端口可达，但配对或 RSD 握手失败。请核对配对记录是否属于这台设备；系统更新后可能需要重新配对。"
    : "未发现可用配对端口。请检查 VPN/Surge 的反射 IP、隧道状态和开发者模式；切换网络后可重新检测。"
  throw new Error(`未能建立只读 RSD 会话。已扫描 ${address}:${SCAN_START}–${SCAN_END}。\n${advice}\n${summary}\n${failures.slice(-3).join("；").slice(0, 1200)}`)
}
