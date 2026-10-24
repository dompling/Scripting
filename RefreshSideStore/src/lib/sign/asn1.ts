// A DER reader — the counterpart to der.ts. Enough to walk a certificate and read back what
// cms.ts builds.
//
// Deliberately low level: it gives back element boundaries and leaves semantics to the caller,
// because the only two things this project needs are "the issuer Name's exact bytes" and "the
// serial number", and a general X.509 object model would be a lot of untested surface.
import type { Bytes } from "../util"
import { bytesToBigInt } from "../util"
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1"

export interface DerElement {
  tag: number
  /** Offset of the tag byte. */
  start: number
  /** Offset of the first content byte. */
  contentStart: number
  /** End of the content, exclusive. */
  end: number
  /** The declared content length. */
  length: number
  constructed: boolean
}

export class DerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DerError"
  }
}

/** Reads one element at `at`. Throws rather than guessing when the encoding is malformed. */
export function derRead(bytes: Bytes, at = 0): DerElement {
  if (at + 2 > bytes.length) throw new DerError(`truncated element at ${at}`)
  const tag = bytes[at]
  const first = bytes[at + 1]
  let length: number
  let contentStart: number
  if ((first & 0x80) === 0) {
    length = first
    contentStart = at + 2
  } else {
    const count = first & 0x7f
    if (count === 0) throw new DerError("indefinite lengths are not DER")
    if (count > 4) throw new DerError(`length of ${count} bytes is absurd at ${at}`)
    if (at + 2 + count > bytes.length) throw new DerError(`truncated length at ${at}`)
    length = 0
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[at + 2 + i]
    contentStart = at + 2 + count
  }
  const end = contentStart + length
  if (end > bytes.length) {
    throw new DerError(
      `element at ${at} claims to end at ${end} but only ${bytes.length} bytes are present`,
    )
  }
  return {
    tag, start: at, contentStart, end, length,
    constructed: (tag & 0x20) !== 0,
  }
}

/** The content bytes of an element. */
export function derContent(bytes: Bytes, element: DerElement): Bytes {
  return bytes.subarray(element.contentStart, element.end)
}

/** The whole element, tag and length included. */
export function derBytes(bytes: Bytes, element: DerElement): Bytes {
  return bytes.subarray(element.start, element.end)
}

/** Every element that follows `at` until `end`. */
export function derSequenceAt(bytes: Bytes, at: number, end: number): DerElement[] {
  const out: DerElement[] = []
  let cursor = at
  while (cursor < end) {
    const element = derRead(bytes, cursor)
    if (element.end > end) {
      throw new DerError(`an element at ${cursor} runs past the container ending at ${end}`)
    }
    out.push(element)
    cursor = element.end
  }
  if (cursor !== end) throw new DerError(`elements at ${at} do not fill up to ${end}`)
  return out
}

/** The children of a constructed element. */
export function derChildren(bytes: Bytes, parent: DerElement): DerElement[] {
  if (!parent.constructed) throw new DerError(`the element at ${parent.start} is not constructed`)
  return derSequenceAt(bytes, parent.contentStart, parent.end)
}

/** The tag of an element as a readable name, for messages. */
export function derTagName(tag: number): string {
  const names: Record<number, string> = {
    0x01: "BOOLEAN", 0x02: "INTEGER", 0x03: "BIT STRING", 0x04: "OCTET STRING",
    0x05: "NULL", 0x06: "OBJECT IDENTIFIER", 0x0c: "UTF8String", 0x13: "PrintableString",
    0x16: "IA5String", 0x17: "UTCTime", 0x18: "GeneralizedTime",
    0x30: "SEQUENCE", 0x31: "SET",
  }
  if ((tag & 0xc0) === 0x80) return `[${tag & 0x1f}]`
  return names[tag] ?? `tag 0x${tag.toString(16).padStart(2, "0")}`
}

// MARK: - the things a certificate needs to yield

/**
 * The fields of a certificate's `tbsCertificate`, with the version skipped.
 *
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }` and
 * `tbsCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature, issuer, validity,
 * subject, subjectPublicKeyInfo, … }`. The version is context-tagged and only present for v3, which
 * is why it is skipped by tag rather than by position — assuming its presence shifts every later
 * field by one.
 */
function tbsFields(der: Bytes): DerElement[] {
  const certificate = derRead(der)
  if (certificate.tag !== 0x30) {
    throw new DerError(`a certificate must be a SEQUENCE, got ${derTagName(certificate.tag)}`)
  }
  const top = derChildren(der, certificate)
  if (top.length < 1) throw new DerError("the certificate has no tbsCertificate")
  const tbs = top[0]
  if (tbs.tag !== 0x30) throw new DerError("tbsCertificate is not a SEQUENCE")
  const fields = derChildren(der, tbs)
  if (fields.length > 0 && (fields[0].tag & 0xc0) === 0x80) return fields.slice(1)
  return fields
}

export interface CertificateIdentity {
  /** The issuer `Name`, as the exact DER of the whole element. */
  issuerDer: Bytes
  /** The serial number's INTEGER content, two's-complement, as stored. */
  serialNumber: Bytes
  /** The certificate's own `Name`, for logging. */
  subjectDer: Bytes
}

/**
 * Pulls out what `SignerInfo.sid` needs from a certificate.
 */
export function parseCertificateIdentity(der: Bytes): CertificateIdentity {
  const fields = tbsFields(der)

  const serial = fields[0]
  if (serial === undefined || serial.tag !== 0x02) {
    throw new DerError("tbsCertificate has no serial number where one was expected")
  }
  // Fields: serialNumber, signature, issuer, validity, subject
  const issuer = fields[2]
  if (issuer === undefined || issuer.tag !== 0x30) {
    throw new DerError("tbsCertificate has no issuer Name where one was expected")
  }
  const subject = fields[4]
  if (subject === undefined || subject.tag !== 0x30) {
    throw new DerError("tbsCertificate has no subject Name where one was expected")
  }

  return {
    issuerDer: derBytes(der, issuer),
    serialNumber: derContent(der, serial),
    subjectDer: derBytes(der, subject),
  }
}

/** An RSA public key, as a certificate carries one. */
export interface RsaPublicKey {
  modulus: bigint
  publicExponent: bigint
}

/**
 * The RSA public key inside a certificate — what says whether a certificate is one of ours.
 *
 * Apple ties a certificate to the key that asked for it, and nothing in the listing says which key
 * that was, so the only way to tell "a certificate I can use" from "a certificate I must not
 * touch" is to read the key out of the certificate and compare it with the one we hold.
 *
 * The algorithm is checked rather than assumed: an elliptic-curve certificate would otherwise
 * yield two integers that look like a key and happen to compare unequal to everything.
 */
export function certificatePublicKey(der: Bytes): RsaPublicKey {
  const fields = tbsFields(der)
  const spki = fields[5]
  if (spki === undefined || spki.tag !== 0x30) {
    throw new DerError("tbsCertificate has no subjectPublicKeyInfo where one was expected")
  }

  const parts = derChildren(der, spki)
  const algorithm = parts[0]
  const bitString = parts[1]
  if (algorithm === undefined || bitString === undefined || bitString.tag !== 0x03) {
    throw new DerError("subjectPublicKeyInfo is not an algorithm followed by a BIT STRING")
  }
  const algorithmOid = (() => {
    const oid = derChildren(der, algorithm)[0]
    if (oid === undefined) throw new DerError("the key algorithm carries no OID")
    return derOidString(der, oid)
  })()
  if (algorithmOid !== OID_RSA_ENCRYPTION) {
    throw new DerError(`the certificate's key is ${algorithmOid}, not RSA`)
  }

  const content = derContent(der, bitString)
  if (content.length === 0 || content[0] !== 0) {
    throw new DerError("the public key's BIT STRING does not start on a byte boundary")
  }
  const rsaPublicKey = derRead(der, bitString.contentStart + 1)
  const numbers = derChildren(der, rsaPublicKey)
  if (numbers.length < 2 || numbers[0].tag !== 0x02 || numbers[1].tag !== 0x02) {
    throw new DerError("an RSAPublicKey is a modulus and an exponent, both INTEGERs")
  }

  return {
    modulus: bytesToBigInt(derContent(der, numbers[0])),
    publicExponent: bytesToBigInt(derContent(der, numbers[1])),
  }
}

/** Reads an OID's dotted form, for comparing against a constant. */
export function derOidString(bytes: Bytes, element: DerElement): string {
  if (element.tag !== 0x06) throw new DerError("not an OBJECT IDENTIFIER")
  const content = derContent(bytes, element)
  if (content.length === 0) throw new DerError("an OID cannot be empty")
  const arcs: number[] = [Math.floor(content[0] / 40), content[0] % 40]
  let value = 0
  for (let i = 1; i < content.length; i++) {
    value = value * 128 + (content[i] & 0x7f)
    if ((content[i] & 0x80) === 0) {
      arcs.push(value)
      value = 0
    }
  }
  return arcs.join(".")
}
