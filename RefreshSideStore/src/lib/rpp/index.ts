// RemotePairing protocol: pair-setup (SRP6a + Ed25519), pair-verify (X25519 ECDH), streaming
// channel, and Bonjour discovery. Internal encoding (TLV/OPACK/ChaCha20-Poly1305/XPC) is hidden.

export { PairSetupHost, type RPPeer, SocketPeer } from "./pairsetup"
export { PairVerifyClient } from "./pairverify"
export {
  PairStore, pairingFileToXml, pairingFileFromXml, parsePairingRecord, exportPairingRecord,
  type PairingFile, type PairingExportFormat,
} from "./pairstore"
export { StreamChannel, createListenerPort } from "./stream"
export {
  publishPairableHost,
  pairableHostTxt,
  seesOwnPairableHost,
  PAIRABLE_HOST_TYPE,
  TXT_KEYS_EXPECTED,
} from "./bonjour"

// XPC is exposed for RSD layer
export type { XpcDictionaryEntry, XpcMessage, XpcValue } from "./xpc"
export {
  REPLY_CHANNEL,
  ROOT_CHANNEL,
  XPC_FLAG,
  decodeXpcBody,
  decodeXpcMessage,
  deviceHandshakeFrame,
  encodeXpcBody,
  encodeXpcMessage,
  http2DataFrame,
  http2HeadersFrame,
  http2WindowUpdateFrame,
  parseHttp2Frame,
  rsdHandshakeFrames,
  xpcArray,
  xpcBool,
  xpcData,
  xpcDictionary,
  xpcEmptyDictionary,
  xpcFileTransfer,
  xpcFromPlist,
  xpcInt64,
  xpcNull,
  xpcString,
  xpcUInt64,
} from "./xpc"
