// Synchronous hashing via the global, Data-based `Crypto`.
//
// `lib/util/srp.ts` has its own `hashWith` for SHA-256/512; this is a separate module because
// code signing also needs SHA-1, and because srp.ts is verified and best left alone.
//
// The receiver must be kept: these are Objective-C-bridged methods, and detaching one into a
// bare function reference fails with "self type check failed for Objective-C instance method".
import type { Bytes } from "./bytes"

type Hasher = (data: any) => any

function hasher(method: "sha1" | "sha256" | "sha512"): Hasher {
  const Crypto: any = (globalThis as any).Crypto
  if (Crypto === undefined) throw new Error("hash: this build of Scripting has no global Crypto")
  switch (method) {
    // Each arrow closes over `Crypto` and calls through it, so the receiver survives.
    case "sha1": return (data: any) => Crypto.sha1(data)
    case "sha256": return (data: any) => Crypto.sha256(data)
    case "sha512": return (data: any) => Crypto.sha512(data)
  }
}

function digest(method: "sha1" | "sha256" | "sha512", bytes: Bytes): Bytes {
  const D: any = (globalThis as any).Data
  const hash = hasher(method)
  return new Uint8Array(hash(D.fromUint8Array(bytes)).toUint8Array())
}

export function sha1(bytes: Bytes): Bytes {
  return digest("sha1", bytes)
}

export function sha256(bytes: Bytes): Bytes {
  return digest("sha256", bytes)
}

export function sha512(bytes: Bytes): Bytes {
  return digest("sha512", bytes)
}

/** The hash algorithms a CodeDirectory can name, and their digest lengths. */
export type HashAlgorithm = "sha1" | "sha256" | "sha384"

export function hashOf(algorithm: HashAlgorithm, bytes: Bytes): Bytes {
  switch (algorithm) {
    case "sha1": return sha1(bytes)
    case "sha256": return sha256(bytes)
    case "sha384": {
      // SHA-384 is SHA-512 with a different initial state, which the runtime does not expose.
      // It appears in CodeDirectory hashType 4, which nothing here generates.
      throw new Error("hash: SHA-384 is not available in this runtime")
    }
  }
}

export function hashLength(algorithm: HashAlgorithm): number {
  return algorithm === "sha1" ? 20 : algorithm === "sha256" ? 32 : 48
}

/** The runtime's own names for the CodeDirectory hashType field. */
export const CS_HASH_TYPE = {
  1: "sha1",
  2: "sha256",
  3: "sha256",   // truncated; same digest, the CodeDirectory just stores fewer bytes
  4: "sha384",
} as const

export function algorithmForHashType(hashType: number): HashAlgorithm {
  const algorithm = (CS_HASH_TYPE as Record<number, HashAlgorithm | undefined>)[hashType]
  if (algorithm === undefined) throw new Error(`hash: unknown CodeDirectory hashType ${hashType}`)
  return algorithm
}
