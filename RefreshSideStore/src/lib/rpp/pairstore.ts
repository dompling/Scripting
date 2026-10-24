// The host's long-lived identity for RPPairing, and the pairing file it produces.
//
// Two 16-byte IRKs live in this story and are easy to conflate:
//   - the HOST's altIRK, which the Bonjour authTag is derived from and which lives here, and
//   - the DEVICE's altIRK, which arrives in the M5 Info blob and goes into the pairing file.
// Re-pairing reuses the host key pair and host altIRK, and clears the device's.
import type { Bytes } from "../util"
import { concat, fromBase64, fromBase64Url, fromUtf8, randomBytes, toBase64, toBase64Url, utf8, writeBinaryPlist } from "../util"
import { globalStore, type KeyValueStore } from "../util"
import { asDict, parsePlist, str, writeXml, type PlistDict, type PlistValue } from "../util"

// MARK: - identity

export interface HostIdentity {
  /** 32-byte Ed25519 public key. */
  publicKey: Bytes
  /** 32-byte Ed25519 private seed. */
  privateKey: Bytes
  /** The service identifier. The device keys its record on this, so it must never change. */
  identifier: string
  /** The host's own 16-byte IRK. The Bonjour authTag derives from it. */
  altIrk: Bytes
}

/** The DNS namespace UUID, from RFC 4122 appendix C. */
const NAMESPACE_DNS = new Uint8Array([
  0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1,
  0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
])

/**
 * UUID v3, the name-based form the reference implementation derives its identifier from
 * (`Uuid::new_v3(NAMESPACE_DNS, name)`). Same name gives the same identifier everywhere, so
 * this script and the original app would agree on it.
 */
export function uuidV3(namespace: Bytes, name: string): string {
  const Crypto: any = (globalThis as any).Crypto
  const D: any = (globalThis as any).Data
  const digest = new Uint8Array(
    Crypto.md5(D.fromUint8Array(concat(namespace, utf8(name)))).toUint8Array(),
  )
  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x30 // version 3
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface PairingFile {
  /** The HOST's Ed25519 public key, 32 bytes. */
  publicKey: Bytes
  /** The HOST's Ed25519 private seed, 32 bytes. */
  privateKey: Bytes
  /** The HOST's service identifier. */
  identifier: string
  /** The DEVICE's IRK from the M5 Info blob. Absent until a device has paired. */
  deviceAltIrk: Bytes | null
}

export function pairingFileToPlist(file: PairingFile): PlistDict {
  const out: PlistDict = {
    public_key: file.publicKey,
    private_key: file.privateKey,
    identifier: file.identifier,
  }
  // Absent rather than empty when there is no device IRK: the reference reader treats a
  // zero-length value as malformed, and the Rust side simply omits the key.
  if (file.deviceAltIrk !== null) out.alt_irk = file.deviceAltIrk
  return out
}

/** XML, never binary: readers in the wild open this with `String(contentsOf:)`. */
export function pairingFileToXml(file: PairingFile): string {
  return writeXml(pairingFileToPlist(file))
}

function bytesValue(dict: PlistDict, key: string): Bytes | null {
  const value = dict[key]
  return value instanceof Uint8Array ? value : null
}

/** Throws with a specific reason, because a malformed pairing file is only found here. */
export function pairingFileFromPlist(root: PlistValue): PairingFile {
  const dict = asDict(root)
  const publicKey = bytesValue(dict, "public_key")
  const privateKey = bytesValue(dict, "private_key")
  const identifier = str(dict, "identifier")
  const deviceAltIrk = bytesValue(dict, "alt_irk")

  if (publicKey === null || publicKey.length !== 32) {
    throw new Error(`pairing file: public_key must be 32 bytes, got ${publicKey?.length ?? "none"}`)
  }
  if (privateKey === null || privateKey.length !== 32) {
    throw new Error(`pairing file: private_key must be 32 bytes, got ${privateKey?.length ?? "none"}`)
  }
  if (identifier === undefined || identifier.length === 0) {
    throw new Error("pairing file: identifier is missing or empty")
  }
  if (deviceAltIrk !== null && deviceAltIrk.length !== 16) {
    throw new Error(`pairing file: alt_irk must be 16 bytes, got ${deviceAltIrk.length}`)
  }
  return { publicKey, privateKey, identifier, deviceAltIrk }
}

export function pairingFileFromXml(xml: string): PairingFile {
  return pairingFileFromPlist(parsePlist(xml))
}

export type PairingExportFormat = "xml" | "binary" | "json"

function recordBytes(value: unknown): Bytes | null {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return new Uint8Array(value)
  }
  if (typeof value !== "string") return null
  const clean = value.trim().replace(/^<|>$/g, "")
  if (/^(?:[0-9a-f]{2})+$/i.test(clean)) return new Uint8Array(clean.match(/../g)!.map(pair => parseInt(pair, 16)))
  try { return fromBase64(clean) } catch { return null }
}

/** Reads XML/binary plist and WLOC/Device Toolbox JSON without logging private keys. */
export function parsePairingRecord(input: Bytes | string): { file: PairingFile, udid: string, name: string, hostAltIrk: Bytes | null } {
  const bytes = typeof input === "string" ? utf8(input) : input
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error("pairing file: empty or too large")
  const text = fromUtf8(bytes)
  const json = text.trimStart().startsWith("{")
  const root = json ? JSON.parse(text) : parsePlist(bytes)
  const dict = asDict(root)
  const pick = (...keys: string[]) => keys.map(key => dict[key]).find(value => value !== undefined)
  const publicKey = recordBytes(pick("public_key", "publicKey", "hostPublicKey", "HostPublicKey"))
  const privateKey = recordBytes(pick("private_key", "privateKey", "hostPrivateSeed", "HostPrivateKey"))
  const deviceAltIrk = recordBytes(pick("alt_irk", "altIrk", "AltIRK"))
  const hostAltIrk = recordBytes(pick("host_alt_irk", "hostAltIrk"))
  const identifier = pick("identifier", "HostID", "hostId", "host_id")
  const udid = pick("device_udid", "deviceUDID", "DeviceUDID", "UDID", "udid")
  const name = pick("device_name", "deviceName", "DeviceName", "name")
  if (publicKey?.length !== 32 || privateKey?.length !== 32 || deviceAltIrk?.length !== 16 ||
      typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("pairing file: incomplete host key or device IRK")
  }
  if (typeof udid !== "string" || udid.trim().length === 0) throw new Error("pairing file: device UDID is required for installation")
  if (hostAltIrk !== null && hostAltIrk.length !== 16) throw new Error("pairing file: invalid host IRK")
  return {
    file: { publicKey, privateKey, identifier, deviceAltIrk },
    udid: udid.trim(), name: typeof name === "string" && name.trim() ? name.trim() : "iPhone",
    hostAltIrk,
  }
}

export function exportPairingRecord(file: PairingFile, udid: string, name: string, format: PairingExportFormat): Bytes | string {
  const dict: PlistDict = { ...pairingFileToPlist(file) }
  if (udid) dict.device_udid = udid
  if (name) dict.device_name = name
  if (format === "binary") return writeBinaryPlist(dict)
  if (format === "xml") return writeXml(dict)
  const hex = (bytes: Bytes) => Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0")).join("")
  return JSON.stringify({
    identifier: file.identifier, privateKey: hex(file.privateKey), publicKey: hex(file.publicKey),
    altIrk: file.deviceAltIrk === null ? "" : hex(file.deviceAltIrk), deviceUDID: udid, deviceName: name,
  }, null, 2)
}

// MARK: - store

const IDENTITY_KEY = "rpp.host.identity"
const PAIRING_FILE_KEY = "rpp.pairing.file"

interface StoredIdentity {
  publicKey: string
  privateKey: string
  identifier: string
  altIrk: string
}

/** Marks the identifier as ours so a future default is not silently adopted. */
const HOST_NAME = "AppExpiryReader"

export class PairStore {
  constructor(private readonly store: KeyValueStore = globalStore()) {}

  // MARK: host identity

  /**
   * The host identity, generated once and then reused forever. A new key pair invalidates
   * every pairing file already placed in other apps; a new altIRK means an already-paired
   * device stops recognising us; a new identifier orphans the device's record entirely.
   */
  async identity(): Promise<HostIdentity> {
    const saved = this.store.get<StoredIdentity>(IDENTITY_KEY)
    if (saved !== null && typeof saved === "object" && typeof saved.identifier === "string") {
      return {
        publicKey: fromBase64(saved.publicKey),
        privateKey: fromBase64(saved.privateKey),
        identifier: saved.identifier,
        altIrk: fromBase64(saved.altIrk),
      }
    }
    const created = await generateIdentity()
    this.store.set<StoredIdentity>(IDENTITY_KEY, {
      publicKey: toBase64(created.publicKey),
      privateKey: toBase64(created.privateKey),
      identifier: created.identifier,
      altIrk: toBase64(created.altIrk),
    })
    return created
  }

  /** The Ed25519 private key as a WebCrypto handle, for signing. */
  async signingKey(identity: HostIdentity): Promise<CryptoKey> {
    const subtle: any = (globalThis as any).crypto.subtle
    return subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: toBase64Url(identity.publicKey), d: toBase64Url(identity.privateKey) },
      { name: "Ed25519" },
      false,
      ["sign"],
    )
  }

  /** A public key handle, for verifying a peer. */
  async verifyKey(publicKey: Bytes): Promise<CryptoKey> {
    const subtle: any = (globalThis as any).crypto.subtle
    return subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"])
  }

  // MARK: pairing file

  /**
   * The pairing file to re-pair with. The device's IRK is deliberately cleared: it belongs to
   * whoever paired last, and carrying it into a pairing with a different iPhone would leave a
   * stale device identity in the file.
   */
  async fileForNewPairing(): Promise<PairingFile> {
    const identity = await this.identity()
    return {
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      identifier: identity.identifier,
      deviceAltIrk: null,
    }
  }

  load(): PairingFile | null {
    const xml = this.store.get<string>(PAIRING_FILE_KEY)
    if (xml === null || typeof xml !== "string" || xml.length === 0) return null
    try {
      return pairingFileFromXml(xml)
    } catch {
      // A file we cannot read is worse than none: pairing again is cheap.
      return null
    }
  }

  save(file: PairingFile): void {
    this.store.set(PAIRING_FILE_KEY, pairingFileToXml(file))
  }

  /** Keep the host identity and pairing file in sync for pair-verify. */
  async importRecord(input: Bytes | string): Promise<{ udid: string, name: string }> {
    const { file, udid, name, hostAltIrk } = parsePairingRecord(input)
    const previous = this.store.get<StoredIdentity>(IDENTITY_KEY)
    const sameHost = previous?.identifier === file.identifier && previous.privateKey === toBase64(file.privateKey)
    const identity: HostIdentity = {
      publicKey: file.publicKey, privateKey: file.privateKey, identifier: file.identifier,
      altIrk: hostAltIrk ?? (sameHost && previous !== null ? fromBase64(previous.altIrk) : randomBytes(16)),
    }
    const signer = await this.signingKey(identity)
    const verifier = await this.verifyKey(file.publicKey)
    const challenge = utf8("sideinstaller-pairing-import")
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, signer, challenge)
    if (!await crypto.subtle.verify({ name: "Ed25519" }, verifier, signature, challenge)) {
      throw new Error("pairing file: public and private keys do not match")
    }
    this.store.set<StoredIdentity>(IDENTITY_KEY, {
      publicKey: toBase64(file.publicKey), privateKey: toBase64(file.privateKey),
      identifier: file.identifier, altIrk: toBase64(identity.altIrk),
    })
    this.save(file)
    return { udid, name }
  }

  /** True once a device has completed pair-setup against us. */
  hasDeviceIrk(): boolean {
    const file = this.load()
    return file !== null && file.deviceAltIrk !== null
  }

  /** Whether a record is held at all, without reading it back. */
  hasRecord(): boolean {
    const xml = this.store.get<string>(PAIRING_FILE_KEY)
    return typeof xml === "string" && xml.length > 0
  }

  clear(): void {
    this.store.remove(PAIRING_FILE_KEY)
  }
}

// MARK: - generation

async function generateIdentity(): Promise<HostIdentity> {
  const subtle: any = (globalThis as any).crypto.subtle
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const jwk: any = await subtle.exportKey("jwk", pair.privateKey)
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("rpp: Ed25519 export did not yield both x and d")
  }
  return {
    publicKey: fromBase64Url(jwk.x),
    privateKey: fromBase64Url(jwk.d),
    // Derived from the name, so it is reproducible rather than random.
    identifier: uuidV3(NAMESPACE_DNS, HOST_NAME),
    altIrk: randomBytes(16),
  }
}
