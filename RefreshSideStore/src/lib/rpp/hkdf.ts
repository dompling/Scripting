// HKDF-SHA512 over crypto.subtle, plus the salt/info labels RPPairing derives keys with.

import { Bytes, utf8 } from "../util"

export const HKDF_LABELS = {
  pairSetupEncryptSalt: "Pair-Setup-Encrypt-Salt",
  pairSetupEncryptInfo: "Pair-Setup-Encrypt-Info",
  pairSetupControllerSignSalt: "Pair-Setup-Controller-Sign-Salt",
  pairSetupControllerSignInfo: "Pair-Setup-Controller-Sign-Info",
  pairSetupAccessorySignSalt: "Pair-Setup-Accessory-Sign-Salt",
  pairSetupAccessorySignInfo: "Pair-Setup-Accessory-Sign-Info",
  pairVerifyEncryptSalt: "Pair-Verify-Encrypt-Salt",
  pairVerifyEncryptInfo: "Pair-Verify-Encrypt-Info",
  clientEncrypt: "ClientEncrypt-main",
  serverEncrypt: "ServerEncrypt-main",
} as const

function subtle(): any {
  const value: any = (globalThis as any).crypto
  if (!value || !value.subtle) throw new Error("hkdf: crypto.subtle is unavailable")
  return value.subtle
}

/**
 * HKDF-SHA512. A null salt means "no salt" (`Hkdf::new(None, …)`), which is the empty
 * salt for the HMAC — not a zero-filled one. SHA-1 is not available on this runtime.
 */
export async function hkdfSha512(ikm: Bytes, salt: Bytes | null, info: Bytes | string, length: number): Promise<Bytes> {
  if (length <= 0 || length > 64 * 255) throw new Error(`hkdf: bad output length ${length}`)
  const webCrypto = subtle()
  const key = await webCrypto.importKey("raw", ikm, { name: "HKDF", hash: "SHA-512" }, false, ["deriveBits"])
  const bits = await webCrypto.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-512",
      salt: salt ?? new Uint8Array(0),
      info: typeof info === "string" ? utf8(info) : info,
    },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** The 32-byte key that protects the pair-setup M5/M6 blobs. */
export function pairSetupEncryptKey(sessionKey: Bytes): Promise<Bytes> {
  return hkdfSha512(sessionKey, utf8(HKDF_LABELS.pairSetupEncryptSalt), HKDF_LABELS.pairSetupEncryptInfo, 32)
}

/** The 32-byte key that protects the pair-verify M3 blob. */
export function pairVerifyEncryptKey(sharedSecret: Bytes): Promise<Bytes> {
  return hkdfSha512(sharedSecret, utf8(HKDF_LABELS.pairVerifyEncryptSalt), HKDF_LABELS.pairVerifyEncryptInfo, 32)
}

/**
 * The 32-byte key for the post-pairing `streamEncrypted` channel. `role` is the side we
 * are: we are the host, so we encrypt with `client` and decrypt with `server`.
 */
export function streamKey(sharedSecret: Bytes, role: "client" | "server"): Promise<Bytes> {
  const label = role === "client" ? HKDF_LABELS.clientEncrypt : HKDF_LABELS.serverEncrypt
  return hkdfSha512(sharedSecret, null, label, 32)
}

/**
 * The 32-byte `X` folded into the M5/M6 signature input. `controller` is the device,
 * `accessory` is us (the pairable host).
 */
export function pairSetupSignSecret(sessionKey: Bytes, role: "controller" | "accessory"): Promise<Bytes> {
  if (role === "controller") {
    return hkdfSha512(sessionKey, utf8(HKDF_LABELS.pairSetupControllerSignSalt), HKDF_LABELS.pairSetupControllerSignInfo, 32)
  }
  return hkdfSha512(sessionKey, utf8(HKDF_LABELS.pairSetupAccessorySignSalt), HKDF_LABELS.pairSetupAccessorySignInfo, 32)
}
