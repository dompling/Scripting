// misagent: the device's provisioning-profile store.
//
// A sideloaded app's profile expires after seven days, and renewing it needs nothing from the app:
// renewal is NOT done by this reader. Same shape as the other
// `.shim.remote` services — one `{MessageType: …}` request in, one plist with `Status` back — so
// this reader implements only CopyAll and a status check.
import { Bytes } from "../util"
import { PlistStream, rsdCheckin, type ByteStream } from "./stream"

/** The store holds one kind of thing here; every request names it. */
const PROFILE_TYPE = "Provisioning"

export class MisagentClient {
  private readonly plists: PlistStream

  private constructor(private readonly stream: ByteStream) {
    this.plists = new PlistStream(stream)
  }

  static async connect(stream: ByteStream, label: string): Promise<MisagentClient> {
    await rsdCheckin(stream, label)
    return new MisagentClient(stream)
  }

  /** Closes the connection, when the transport has one. */
  async disconnect(): Promise<void> {
    if (this.stream.close !== undefined) await this.stream.close()
  }

  /**
   * Every provisioning profile installed on the device, as the CMS bytes a `.mobileprovision` file
   * holds. Decoding them is `parseProvisioningProfile`'s job.
   */
  async copyAll(): Promise<Bytes[]> {
    await this.plists.send({ MessageType: "CopyAll", ProfileType: PROFILE_TYPE })
    const reply = await this.plists.receive()
    if (reply === null) throw new Error("misagent: the device closed without answering CopyAll")
    this.assertStatus(reply, "CopyAll")

    const payload = reply.Payload
    if (!Array.isArray(payload)) throw new Error("misagent: CopyAll answered without a Payload array")
    // A non-data entry is the device saying something this client does not understand; skipping it
    // silently would show fewer profiles than the device holds, which is the one thing the page
    // must not do.
    return payload.map(entry => {
      if (!(entry instanceof Uint8Array)) throw new Error("misagent: CopyAll Payload held a non-data entry")
      return entry
    })
  }

  /**
   * A command that did not answer `Status: 0` failed, and the number is the device's only account
   * of why.
   */
  private assertStatus(reply: Record<string, unknown>, command: string): void {
    const status = reply.Status
    if (typeof status !== "number" || status !== 0) {
      throw new Error(`misagent: ${command} answered Status ${String(status)}`)
    }
  }
}
