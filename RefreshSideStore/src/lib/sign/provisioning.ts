// `.mobileprovision`: a CMS SignedData whose content is a plist.
//
// The plist carries the entitlements the app is allowed to have, which is what makes it more than
// a file to copy into the bundle: those entitlements, not the ones already inside the app, are what
// gets signed into the CodeDirectory.
//
// The content is read out of the CMS rather than searched for, so a profile whose signature does
// not cover the plist it carries cannot pass as valid.
import { Bytes } from "../util"
import { asDict, parsePlist, str, type PlistDict, type PlistValue } from "../util"
import { derChildren, derContent, derRead, DerError } from "./asn1"

/** The OID of `signedData`, which is what a profile is wrapped in. */
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2"

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisioningError"
  }
}

/**
 * The `eContent` octets of a CMS SignedData.
 *
 * `ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT SignedData }`, and
 * `SignedData ::= SEQUENCE { version, digestAlgorithms, encapContentInfo, ... }` where
 * `encapContentInfo ::= SEQUENCE { eContentType OID, [0] EXPLICIT OCTET STRING OPTIONAL }`.
 * A profile is signed *with* the content embedded, so the octets must be there.
 */
export function cmsContent(cms: Bytes): Bytes {
  const root = derRead(cms)
  const rootChildren = derChildren(cms, root)
  if (rootChildren.length < 2) {
    throw new ProvisioningError("a profile's outer ContentInfo should have two children")
  }
  const signedData = derChildren(cms, rootChildren[1])[0]
  const fields = derChildren(cms, signedData)
  if (fields.length < 3) {
    throw new ProvisioningError(
      `SignedData should have at least three children, found ${fields.length}`,
    )
  }
  const contentInfo = fields[2]
  const parts = derChildren(cms, contentInfo)
  if (parts.length < 2) {
    throw new ProvisioningError(
      "this profile has no embedded content — it was signed detached, which a profile never is",
    )
  }
  const explicit = parts[1]
  if ((explicit.tag & 0xc0) !== 0x80) {
    throw new ProvisioningError("the eContent should be context-tagged")
  }
  const octets = derChildren(cms, explicit)[0]
  if (octets === undefined) throw new ProvisioningError("the eContent is empty")
  return derContent(cms, octets)
}

export interface ProvisioningProfile {
  /** The whole file, which is what gets copied into the bundle. */
  raw: Bytes
  /** The plist the CMS covers. */
  plist: PlistDict
  /** The entitlements the app is allowed to carry. Empty if the profile has none. */
  entitlements: PlistDict
  /** The profile's own identifier, e.g. `XYZ0123456.com.example.app` or `XYZ0123456.*`. */
  applicationIdentifier: string | null
  /** The prefix an app identifier must start with. */
  identifierPrefix: string | null
  teamIdentifier: string | null
  uuid: string | null
  name: string | null
  expirationDate: Date | null
  /** DER certificates the profile authorises. */
  developerCertificates: Bytes[]
  /** Device UDIDs, or null when the profile is not device-limited. */
  provisionedDevices: string[] | null
}

/** Reads a profile's plist out of its signature, and pulls out the fields that matter. */
export function parseProvisioningProfile(bytes: Bytes): ProvisioningProfile {
  let plist: PlistDict
  try {
    plist = asDict(parsePlist(cmsContent(bytes)))
  } catch (error) {
    if (error instanceof DerError) {
      throw new ProvisioningError(`this is not a CMS-wrapped profile: ${error.message}`)
    }
    throw error
  }

  const rawEntitlements = plist.Entitlements
  const entitlements = isDict(rawEntitlements) ? rawEntitlements : {}

  const prefixList = plist.ApplicationIdentifierPrefix
  const identifierPrefix = Array.isArray(prefixList) && typeof prefixList[0] === "string"
    ? prefixList[0]
    : null

  const teams = plist.TeamIdentifier
  const teamIdentifier = Array.isArray(teams) && typeof teams[0] === "string" ? teams[0] : null

  const certificateList = plist.DeveloperCertificates
  const developerCertificates = Array.isArray(certificateList)
    ? certificateList.filter((value): value is Bytes => value instanceof Uint8Array)
    : []

  const devices = plist.ProvisionedDevices
  const provisionedDevices = Array.isArray(devices)
    ? devices.filter((value): value is string => typeof value === "string")
    : null

  const expiration = plist.ExpirationDate

  return {
    raw: bytes,
    plist,
    entitlements,
    applicationIdentifier: str(entitlements, "application-identifier") ?? null,
    identifierPrefix,
    teamIdentifier,
    uuid: str(plist, "UUID") ?? null,
    name: str(plist, "Name") ?? null,
    expirationDate: expiration instanceof Date ? expiration : null,
    developerCertificates,
    provisionedDevices,
  }
}

/** Whether the profile has run out. A device refuses an expired profile, so this is worth checking. */
export function isExpired(profile: ProvisioningProfile, now = new Date()): boolean {
  if (profile.expirationDate === null) return false
  return profile.expirationDate.getTime() <= now.getTime()
}

/**
 * The entitlements to sign a given bundle identifier with.
 *
 * Re-signing replaces the identity-bearing entitlements with ones for the new identifier; keeping
 * the old `application-identifier` would make the signature describe an app the profile does not
 * cover, which the device rejects. The rest of the profile's entitlements are passed through
 * unchanged — they are the capabilities the profile grants.
 */
export function entitlementsFor(
  profile: ProvisioningProfile,
  bundleIdentifier: string,
): PlistDict {
  const prefix = profile.identifierPrefix ?? profile.teamIdentifier
  if (prefix === null) {
    throw new ProvisioningError(
      "the profile carries neither an ApplicationIdentifierPrefix nor a TeamIdentifier, so the " +
      "app identifier cannot be built",
    )
  }
  const applicationIdentifier = `${prefix}.${bundleIdentifier}`

  const out: PlistDict = { ...profile.entitlements }
  out["application-identifier"] = applicationIdentifier

  // Only rewrite the keychain groups that named the profile's own app; a group that is not derived
  // from the old identifier is a deliberate shared group and must be left alone.
  const groups = out["keychain-access-groups"]
  if (Array.isArray(groups)) {
    out["keychain-access-groups"] = groups.map(group =>
      typeof group === "string" && group.endsWith(profile.applicationIdentifier ?? "\u0000")
        ? applicationIdentifier
        : group)
  }

  if (profile.teamIdentifier !== null) {
    out["com.apple.developer.team-identifier"] = profile.teamIdentifier
  }
  return out
}

/**
 * The bundle identifier a nested bundle should get.
 *
 * A plugin's identifier is derived from its host's, so re-signing an app with a new identifier has
 * to move the plugins too. `com.old.app.Widget` under `com.new.app` becomes `com.new.app.Widget`;
 * an identifier that does not look derived is left alone, because guessing would be worse.
 */
export function nestedBundleIdentifier(
  hostIdentifier: string,
  originalHostIdentifier: string,
  originalIdentifier: string,
): string {
  if (originalIdentifier === originalHostIdentifier) return hostIdentifier
  const prefix = `${originalHostIdentifier}.`
  if (originalIdentifier.startsWith(prefix)) {
    return `${hostIdentifier}.${originalIdentifier.slice(prefix.length)}`
  }
  return originalIdentifier
}

function isDict(value: PlistValue | undefined): value is PlistDict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !(value instanceof Uint8Array) && !(value instanceof Date)
}
