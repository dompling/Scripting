// ChaCha20-Poly1305 as this runtime exposes it: crypto.chacha20Poly1305, output ct‖tag.

import { Bytes, utf8 } from "../util"

/** Nonces RPPairing spells out in its source. */
export const PS_MSG05 = "PS-Msg05"
export const PS_MSG06 = "PS-Msg06"
export const PV_MSG03 = "PV-Msg03"

function api(): any {
  const value: any = (globalThis as any).crypto
  if (!value || !value.chacha20Poly1305) throw new Error("aead: crypto.chacha20Poly1305 is unavailable")
  return value.chacha20Poly1305
}

function params(key: Bytes, nonce: Bytes, aad?: Bytes): Record<string, unknown> {
  if (key.length !== 32) throw new Error(`aead: key must be 32 bytes, got ${key.length}`)
  if (nonce.length !== 12) throw new Error(`aead: nonce must be 12 bytes, got ${nonce.length}`)
  // An empty AAD is the same MAC input as no AAD, so only pass it when there is one.
  return aad && aad.length > 0 ? { key, nonce, additionalData: aad } : { key, nonce }
}

/** Encrypt, returning `ciphertext ‖ 16-byte tag` with no nonce prefix. */
export async function chacha20Poly1305Encrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await api().encrypt(params(key, nonce, aad), plaintext))
}

/** Decrypt a `ciphertext ‖ tag` blob. Throws when the tag does not verify. */
export async function chacha20Poly1305Decrypt(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await api().decrypt(params(key, nonce, aad), ciphertext))
}

/** The 12-byte `\0\0\0\0PS-Msg05`-style nonce: four zero bytes then the 8-char ASCII tag. */
export function messageNonce(tag: string): Bytes {
  const ascii = utf8(tag)
  if (ascii.length !== 8) throw new Error(`aead: nonce tag must be 8 ASCII characters, got ${ascii.length}`)
  const out = new Uint8Array(12)
  out.set(ascii, 4)
  return out
}

/** The post-pairing stream nonce: an 8-byte little-endian counter then four zero bytes. */
export function streamNonce(counter: bigint): Bytes {
  if (counter < 0n) throw new Error("aead: stream counter must be unsigned")
  const out = new Uint8Array(12)
  let rest = counter
  for (let i = 0; i < 8; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}
