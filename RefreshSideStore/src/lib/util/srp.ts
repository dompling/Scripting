// SRP-6a (RFC 5054) with Apple's two deviations, plus the server role pair-setup needs.
//
// Apple's GrandSlam uses the `srp` crate with `new_with_options(false)`: the username is
// left OUT of x, so x = H(salt | H(":" | password_key)). Everything else is textbook.
// Byte serialisation is big-endian with leading zeros stripped, except inside pad().
import { Bytes, bytesToBigInt, bigIntToBytes, concat, fromHex, randomBytes, toHex, utf8 } from "./bytes"

export type HashName = "SHA-256" | "SHA-512"

export type HashFn = (data: Bytes) => Bytes

export interface SRPGroup {
  /** The prime, as a big integer. */
  n: bigint
  /** The generator, usually 2. */
  g: bigint
}

/**
 * Synchronous hashing via the global Data-based `Crypto`. The fake `node:crypto.createHash`
 * rejects every algorithm name, so this is the available sync primitive; `crypto.subtle` is
 * async and would make the whole SRP exchange promise-based for no benefit.
 */
export function hashWith(name: HashName): HashFn {
  const D: any = (globalThis as any).Data
  const Crypto: any = (globalThis as any).Crypto
  // Keep the receiver: these are Objective-C-bridged methods and detaching them makes the
  // call fail with "self type check failed for Objective-C instance method".
  const hash = name === "SHA-512"
    ? (data: any) => Crypto.sha512(data)
    : (data: any) => Crypto.sha256(data)
  return (data: Bytes) => new Uint8Array(hash(D.fromUint8Array(data)).toUint8Array())
}

/** RFC 5054 Appendix A, 2048-bit — the group GrandSlam negotiates. */
export const SRP_GROUP_2048: SRPGroup = {
  n: fromHex(
    "ac6bdb41324a9a9bf166de5e1389582faf72b6651987ee07fc3192943db56050" +
    "a37329cbb4a099ed8193e0757767a13dd52312ab4b03310dcd7f48a9da04fd50" +
    "e8083969edb767b0cf6095179a163ab3661a05fbd5faaae82918a9962f0b93b8" +
    "55f97993ec975eeaa80d740adbf4ff747359d041d5c33ea71d281e446b14773b" +
    "ca97b43a23fb801676bd207a436c6481f1d2b9078717461a5b9d32e688f87748" +
    "544523b524b0d57d5ea77a2775d2ecfa032cfbdbf52fb3786160279004e57ae6" +
    "af874e7303ce53299ccc041c7bc308d82a5698f3a8d0c38271ae35f8e9dbfbb6" +
    "94b5c803d89f7ae435de236d525f54759b65e372fcd68ef20fa7111f9e4aff73",
  ).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
  g: 2n,
}

/**
 * RFC 3526 section 4, the 3072-bit MODP group — what pair-setup runs SRP over.
 *
 * The constant was cross-checked against the RFC's own closed form
 * (`2^3072 - 2^3008 - 1 + 2^64 * (floor(2^2942 * pi) + 1690314)`), because a single wrong
 * hex digit in a 768-character prime would otherwise only surface as a failed pairing.
 * It is a safe prime, so p ≡ 7 (mod 8) holds.
 */
export const SRP_GROUP_3072: SRPGroup = {
  n: fromHex(
    "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74" +
    "020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437" +
    "4fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed" +
    "ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf05" +
    "98da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb" +
    "9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b" +
    "e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf695581718" +
    "3995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33" +
    "a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7" +
    "abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864" +
    "d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e2" +
    "08e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff",
  ).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
  // The generator is 5 for this group, not 2. RFC 5054's 3072-bit group reuses the RFC 3526
  // prime with a different generator, and both halves must agree on it: it decides the verifier,
  // and therefore B, and therefore every proof in the exchange.
  g: 5n,
}

/** Big-endian with leading zero bytes stripped, never empty. */
export function trim(value: bigint): Bytes {
  const raw = bigIntToBytes(value)
  let start = 0
  while (start < raw.length - 1 && raw[start] === 0) start++
  return raw.subarray(start)
}

/** Left-pad to a fixed width. */
export function pad(bytes: Bytes, width: number): Bytes {
  if (bytes.length >= width) return bytes
  const out = new Uint8Array(width)
  out.set(bytes, width - bytes.length)
  return out
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = ((base % modulus) + modulus) % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    e >>= 1n
    b = (b * b) % modulus
  }
  return result
}

function xor(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

/** Shared by both roles: the two hashes that do not depend on which side you are. */
function groupHashes(group: SRPGroup, hash: HashFn, width: number, xorPadsG = true) {
  const nBytes = trim(group.n)
  const gBytes = trim(group.g)
  // `k = H(N | PAD(g))` needs g zero-padded to the modulus width, but the `H(g)` that goes into
  // the M1 prefix must be over the SHORT form. Using the padded one for both is wrong and looks
  // perfectly reasonable, which is what made it survive a full test suite.
  const nXorG = xor(hash(nBytes), hash(xorPadsG ? pad(gBytes, width) : gBytes))
  const k = bytesToBigInt(hash(concat(nBytes, pad(gBytes, width))))
  return { nBytes, gBytes, nXorG, k }
}

function xFromPassword(group: SRPGroup, hash: HashFn, usernameForX: string, salt: Bytes, passwordKey: Bytes): bigint {
  const identity = hash(concat(utf8(usernameForX), utf8(":"), passwordKey))
  return bytesToBigInt(hash(concat(salt, identity)))
}

function clientProof(nXorG: Bytes, username: string, salt: Bytes, aPub: Bytes, bPub: Bytes, sessionKey: Bytes, hash: HashFn): Bytes {
  return hash(concat(nXorG, hash(utf8(username)), salt, aPub, bPub, sessionKey))
}

// MARK: - client

export interface SRPClientOptions {
  group: SRPGroup
  hash: HashFn
  /** The username that goes into M1. */
  username: string
  /**
   * What goes *into x* before the colon. Apple's `srp` crate with options(false) passes
   * the empty string here while still hashing the real username into M1.
   */
  usernameForX?: string
  /** Which proof construction to use. Defaults to `rfc5054`. */
  proofStyle?: SRPProofStyle
}

export class SRPClient {
  readonly aPub: Bytes
  premaster: Bytes | null = null
  sessionKey: Bytes | null = null
  m1: Bytes | null = null
  m2: Bytes | null = null

  private readonly a: bigint
  private readonly width: number
  private readonly opts: SRPClientOptions

  constructor(opts: SRPClientOptions, privateBytes?: Bytes) {
    this.opts = opts
    this.width = trim(opts.group.n).length
    const a = privateBytes ?? randomBytes(32)
    this.a = bytesToBigInt(a)
    this.aPub = trim(modPow(opts.group.g, this.a, opts.group.n))
  }

  /** Feed the server's salt + B, get M1. Throws on B ≡ 0 mod N. */
  process(salt: Bytes, bPubBytes: Bytes, passwordKey: Bytes): Bytes {
    const { group, hash, username, usernameForX } = this.opts
    const idevice = this.opts.proofStyle === "crate"
    const { nXorG, k } = groupHashes(group, hash, this.width, !idevice)

    const bPub = bytesToBigInt(bPubBytes)
    if (bPub % group.n === 0n) throw new Error("srp: server sent B ≡ 0 (mod N)")

    const x = xFromPassword(group, hash, usernameForX ?? "", salt, passwordKey)
    const base = (bPub - k * modPow(group.g, x, group.n)) % group.n

    if (this.opts.proofStyle === "crate") {
      // The mirror of `SRPServer.verifyIdeviceStyle`: `u` over the minimal forms, `K = H(S)`, and
      // the proof over the padded A and B.
      const aPadded = pad(this.aPub, this.width)
      const bPadded = pad(bPubBytes, this.width)
      const u = bytesToBigInt(hash(concat(this.aPub, trim(bPub))))
      const premaster = modPow(base, this.a + u * x, group.n)
      this.premaster = trim(premaster)
      this.sessionKey = hash(this.premaster)
      this.m1 = hash(concat(nXorG, hash(utf8(username)), salt, aPadded, bPadded, this.sessionKey))
      this.m2 = hash(concat(this.aPub, this.m1, this.sessionKey))
      return this.m1
    }

    const u = bytesToBigInt(hash(concat(pad(this.aPub, this.width), pad(bPubBytes, this.width))))
    const premaster = modPow(base, this.a + u * x, group.n)
    this.premaster = trim(premaster)
    this.sessionKey = hash(this.premaster)

    this.m1 = clientProof(nXorG, username, salt, this.aPub, bPubBytes, this.sessionKey, hash)
    this.m2 = hash(concat(this.aPub, this.m1, this.sessionKey))
    return this.m1
  }

  verifyM2(serverM2: Bytes): boolean {
    if (this.m2 === null) throw new Error("srp: process() must run before verifyM2()")
    if (serverM2.length !== this.m2.length) return false
    let diff = 0
    for (let i = 0; i < this.m2.length; i++) diff |= this.m2[i] ^ serverM2[i]
    return diff === 0
  }
}

// MARK: - server (the host side of pair-setup)

export interface SRPServerOptions {
  group: SRPGroup
  hash: HashFn
  /** The username that goes into M1. */
  username: string
  /** What goes into x before the colon. Empty for Apple's variant. Defaults to `username`. */
  usernameForX?: string
  /** Which proof construction to use. Defaults to `rfc5054`. */
  proofStyle?: SRPProofStyle
}

/**
 * Which SRP-6a proof construction to use.
 *
 * `rfc5054` is the textbook one, and it is what the Apple ID login path needs.
 *
 * `crate` is the variant the pair-setup responder in `idevice` uses, and it differs in three
 * places rather than one:
 *
 *   - `u` and the proofs hash the MINIMAL big-endian forms, not forms zero-padded to the modulus
 *     width;
 *   - the session key is the raw premaster secret, not its hash;
 *   - `M1` is `H(A ‖ B ‖ K)`, not RFC 5054's `H(H(N) xor H(g) ‖ H(U) ‖ s ‖ A ‖ B ‖ K)`.
 *
 * Its own source states the last one plainly:
 *
 *     // M1 = H(A, B, K) this doesn't follow the spec but apparently no one does for M1
 *
 * This has to be selectable rather than global because the two paths talk to different servers: an
 * Apple ID login goes to gsa.apple.com, and a pair-setup goes to the device itself. Changing the
 * shared code to one style would break the other path, which is currently working.
 */
export type SRPProofStyle = "rfc5054" | "crate"

export class SRPServer {
  /** v = g^x — what the host stores for a given PIN and salt. */
  static computeVerifier(opts: SRPServerOptions, password: Bytes, salt: Bytes): bigint {
    const x = xFromPassword(opts.group, opts.hash, opts.usernameForX ?? opts.username, salt, password)
    return modPow(opts.group.g, x, opts.group.n)
  }

  readonly bPub: Bytes
  sessionKey: Bytes | null = null
  m2: Bytes | null = null

  private readonly b: bigint
  private readonly width: number
  private readonly opts: SRPServerOptions

  /**
   * `exactWidthBytes` regenerates the ephemeral until B's trimmed length is exactly that
   * many bytes — pair-setup requires a 384-byte (3072-bit) B.
   */
  constructor(opts: SRPServerOptions, verifier: bigint, privateBytes?: Bytes, exactWidthBytes?: number) {
    this.opts = opts
    this.width = trim(opts.group.n).length
    const { k } = groupHashes(opts.group, opts.hash, this.width)

    const attempt = (bBytes: Bytes): { b: bigint, bPub: Bytes } => {
      const b = bytesToBigInt(bBytes)
      const value = (k * verifier + modPow(opts.group.g, b, opts.group.n)) % opts.group.n
      return { b, bPub: trim(value) }
    }

    if (exactWidthBytes === undefined) {
      const bBytes = privateBytes ?? randomBytes(32)
      const out = attempt(bBytes)
      this.b = out.b
      this.bPub = out.bPub
    } else {
      let chosen: { b: bigint, bPub: Bytes } | null = null
      for (let i = 0; i < 1000; i++) {
        const out = attempt(i === 0 && privateBytes !== undefined ? privateBytes : randomBytes(32))
        if (out.bPub.length === exactWidthBytes) {
          chosen = out
          break
        }
      }
      if (chosen === null) throw new Error("srp: could not find a B of the requested width")
      this.b = chosen.b
      this.bPub = chosen.bPub
    }
  }

  /** Check the client's M1; on success computes K and M2. `salt` is the one sent in M2. */
  verify(aPubBytes: Bytes, m1: Bytes, salt: Bytes, verifier: bigint): boolean {
    const { group, hash, username } = this.opts

    if (this.opts.proofStyle === "crate") return this.verifyIdeviceStyle(aPubBytes, m1, salt, verifier)

    const { nXorG } = groupHashes(group, hash, this.width)

    const u = bytesToBigInt(hash(concat(pad(aPubBytes, this.width), pad(this.bPub, this.width))))
    const a = bytesToBigInt(aPubBytes)
    const premaster = modPow((a * modPow(verifier, u, group.n)) % group.n, this.b, group.n)
    const sessionKey = hash(trim(premaster))

    const expected = clientProof(nXorG, username, salt, aPubBytes, this.bPub, sessionKey, hash)
    if (expected.length !== m1.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ m1[i]
    if (diff !== 0) return false

    this.sessionKey = sessionKey
    this.m2 = hash(concat(aPubBytes, m1, sessionKey))
    return true
  }

  /**
   * The pair-setup variant.
   *
   * It is the RFC 5054 shape with one decisive difference: `u` is hashed over the MINIMAL
   * big-endian forms of A and B rather than forms zero-padded to the modulus width. `K` is still
   * `H(S)`, and the proof still hashes the padded A and B.
   */
  private verifyIdeviceStyle(aPubBytes: Bytes, m1: Bytes, salt: Bytes, verifier: bigint): boolean {
    const { group, hash, username } = this.opts
    const { nXorG } = groupHashes(group, hash, this.width, false)

    const u = bytesToBigInt(hash(concat(trim(bytesToBigInt(aPubBytes)), trim(bytesToBigInt(this.bPub)))))
    const a = bytesToBigInt(aPubBytes)
    const premaster = modPow((a * modPow(verifier, u, group.n)) % group.n, this.b, group.n)
    const sessionKey = hash(trim(premaster))

    const expected = clientProof(
      nXorG, username, salt, pad(aPubBytes, this.width), pad(this.bPub, this.width), sessionKey, hash,
    )
    if (expected.length !== m1.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ m1[i]
    if (diff !== 0) return false

    this.sessionKey = sessionKey
    this.m2 = hash(concat(trim(a), m1, sessionKey))
    return true
  }

  /**
   * The variant the pair-setup responder uses.
   *
   * Every hash here is over the minimal big-endian form of its input, and the session key is the
   * premaster itself. `A` is trimmed for the hashes but parsed from the bytes as given, so a
   * client that pads its public key produces the same result either way.
   */
  private verifyCrateStyle(aPubBytes: Bytes, m1: Bytes, verifier: bigint): boolean {
    const { group, hash } = this.opts
    const a = bytesToBigInt(aPubBytes)
    const aMin = trim(a)
    const bMin = this.bPub

    const u = bytesToBigInt(hash(concat(aMin, bMin)))
    const premaster = modPow((a * modPow(verifier, u, group.n)) % group.n, this.b, group.n)
    const sessionKey = trim(premaster)

    const expected = hash(concat(aMin, bMin, sessionKey))
    if (expected.length !== m1.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ m1[i]
    if (diff !== 0) return false

    this.sessionKey = sessionKey
    this.m2 = hash(concat(aMin, m1, sessionKey))
    return true
  }
}

// MARK: - Apple's password transform

/**
 * GrandSlam's `ps`/`sp` negotiation: the password is pre-hashed, optionally hex-encoded,
 * then run through PBKDF2-HMAC-SHA256.
 */
export function applePasswordKey(password: string, salt: Bytes, iterations: number, protocol: "s2k" | "s2k_fo"): Bytes {
  const D: any = (globalThis as any).Data
  const digest = new Uint8Array((globalThis as any).Crypto.sha256(D.fromUint8Array(utf8(password))).toUint8Array())
  const pre = protocol === "s2k_fo" ? utf8(toHex(digest)) : digest
  const derived = require("node:crypto").pbkdf2Sync(pre, salt, iterations, 32, "sha256")
  return new Uint8Array(derived as Uint8Array)
}
