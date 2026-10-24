// Native, user-initiated Remote Pairing. It only creates a trust record; it never changes profiles or apps.
import { PairStore } from "../rpp/pairstore"
import { publishPairableHost, seesOwnPairableHost } from "../rpp/bonjour"
import { PairSetupHost, SocketPeer } from "../rpp/pairsetup"
import { createPairingSurface } from "../../live_activity"

export interface PairResult { name: string; udid: string }
export type Log = (message: string) => void

function deadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  return Promise.race([work, timeout]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

export async function nativePair(log: Log): Promise<PairResult> {
  const store = new PairStore()
  const identity = await store.identity()
  const signingKey = await store.signingKey(identity)
  const server = require("node:net").createServer()
  const surface = createPairingSurface()
  let published: Awaited<ReturnType<typeof publishPairableHost>> | null = null
  let socket: any = null
  let held = false
  let paired = false
  let name = ""
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen({ host: "0.0.0.0", port: 0 }, resolve)
    })
    const port = Number(server.address()?.port)
    if (!Number.isInteger(port) || port < 1) throw new Error("配对 TCP listener 未取得有效端口")
    const pin = Math.floor(100000 + Math.random() * 900000).toString()
    const keeper: any = (globalThis as any).BackgroundKeeper
    if (keeper?.keepAlive) {
      try { held = Boolean(await keeper.keepAlive()); log(held ? "已开启后台保活，请前往系统设置配对" : "后台保活未开启，切换设置后配对可能中断") } catch {}
    }
    published = await publishPairableHost({
      info: { name: "RefreshSideStore", identifier: identity.identifier, model: "Mac17,7", altIrk: identity.altIrk },
      port, includePeerToPeer: true,
    })
    if (!await seesOwnPairableHost(identity.identifier, 2000)) log("Bonjour 自检未发现广播，仍继续等待系统配对")
    const activityError = await surface.start(pin)
    if (activityError) log(activityError)
    log(`配对码：${pin}。前往 设置 → 隐私与安全性 → 开发者模式 → 配对设备，选择 RefreshSideStore。`)
    const incoming = new Promise<any>((resolve, reject) => {
      server.once("connection", resolve)
      server.once("error", reject)
      server.once("close", () => reject(new Error("配对监听已关闭")))
    })
    socket = await deadline(incoming, 120000, "等待 iPhone 连接超时（120 秒）")
    await surface.prompt(pin)
    const host = new PairSetupHost({
      identity, signingKey, pin,
      deviceInfo: { name: "RefreshSideStore", model: "Mac17,7", udid: "" },
      onPin: code => log(`设备请求输入配对码：${code}`),
      verifyDeviceSignature: true,
    })
    const outcome = await deadline(host.run(new SocketPeer(socket)), 90000, "配对验证超时（90 秒）")
    store.save(outcome.file)
    Storage.set("rpp.expiry.device.udid", outcome.device.udid)
    name = outcome.device.name || "iPhone"
    Storage.set("rpp.expiry.device.name", name)
    paired = true
    return { name, udid: outcome.device.udid }
  } finally {
    try { socket?.destroy() } catch {}
    try { published?.stop() } catch {}
    try { server.close() } catch {}
    await surface.finish(paired, name)
    if (held) try { await (globalThis as any).BackgroundKeeper?.stopKeepAlive() } catch {}
  }
}
