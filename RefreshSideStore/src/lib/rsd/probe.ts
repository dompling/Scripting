// Whether anything answers at an address:port on the far side of the reflection, and why not when
// nothing does.
//
// A refusal and a timeout must not be collapsed into "no answer": the first means the packets came
// back and nothing was listening, the second means they never came back at all. Which of the two it
// was is the whole diagnosis.
export interface TcpProbe {
  open: boolean
  /** The failure's code, with our own timer reported as `ETIMEDOUT`. Null when it connected. */
  code: string | null
}

/** Connects and closes again — a probe of the device's remote-pairing port, not of a service. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<TcpProbe> {
  const net = require("node:net")
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const settle = (result: TcpProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* it may be gone already */ }
      resolve(result)
    }

    const timer = setTimeout(() => settle({ open: false, code: "ETIMEDOUT" }), timeoutMs)
    socket.once("connect", () => settle({ open: true, code: null }))
    socket.once("error", (error: { code?: string } | null) =>
      settle({ open: false, code: error?.code ?? "UNKNOWN" }))
  })
}
