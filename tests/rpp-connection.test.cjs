const test = require('node:test')
const assert = require('node:assert/strict')
const { loadTs } = require('./helpers/load-ts.cjs')

function reader(openPort, extraGlobals = {}) {
  const probes = [], opened = []
  const values = new Map()
  const link = { handshake: { services: new Map() }, close: async () => {}, open: async () => ({}) }
  const api = loadTs('rpp-expiry.ts', {
    './lib/rpp/pairstore': { PairStore: class { hasDeviceIrk() { return true } load() { return { deviceAltIrk: new Uint8Array(16) } } } },
    '../rpp/pairstore': { PairStore: class { hasDeviceIrk() { return true } load() { return { deviceAltIrk: new Uint8Array(16) } } } },
    './lib/rsd': { openDeviceLink: async options => { opened.push(options.remotedPort); return link },
      probeTcp: async (host, port) => { probes.push(port); return { open: port === openPort, code: port === openPort ? null : 'ECONNREFUSED' } },
      MisagentClient: { connect: async () => { throw new Error('PROFILE_STAGE_REACHED') } }, SERVICES: { misagent: 'misagent' } },
    '../rsd/device': { openDeviceLink: async options => { opened.push(options.remotedPort); return link } },
    '../rsd/probe': { probeTcp: async (host, port) => { probes.push(port); return { open: port === openPort, code: port === openPort ? null : 'ECONNREFUSED' } } },
    './lib/reader/native-pair': {},
  }, { Storage: { get: key => values.get(key), set: (key, value) => values.set(key, value) }, ...extraGlobals })
  return { api, probes, opened }
}

test('scan finds a dynamic pairing port after preferred and default ports refuse', async () => {
  const { api, probes, opened } = reader(50007)
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.deepEqual(opened, [50007])
  assert.ok(probes.includes(51200), 'fallback covers the entire WLOC range')
  assert.equal(probes.filter(port => port === 49152).length, 1, 'skip already tried ports')
})

test('scan resolves Bonjour records instead of reading port from browse results', async () => {
  let stopped = false, resolutions = 0
  const { api, opened } = reader(62580, { Bonjour: {
    browse: options => { queueMicrotask(() => options.onFound({ name: 'device', type: '_remotepairing._tcp', domain: 'local.' })); return { stop() { stopped = true } } },
    resolve: async () => { resolutions++; return { port: 62580, txtRecord: {} } },
  }, queueMicrotask })
  // No TXT identity is accepted here: authenticate the target with pair-verify on the reflected host.
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.equal(resolutions, 1)
  assert.deepEqual(opened, [62580])
  assert.equal(stopped, true)
})

test('a failed scan reports the scanned range and refused connections', async () => {
  const { api } = reader(-1)
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), error => {
    assert.match(error.message, /49152.*51200/)
    assert.match(error.message, /ECONNREFUSED/)
    return true
  })
})

test('invalid reflected IPv4 is rejected before opening sockets', async () => {
  const { api, probes } = reader(50007)
  await assert.rejects(api.readExpiryViaRpp('bad-host', 62554), /IP|IPv4/)
  assert.equal(probes.length, 0)
})

test('a working preferred port skips Bonjour and the range scan', async () => {
  const { api, probes } = reader(62580, { Bonjour: { browse() { throw new Error('should skip discovery') } } })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62580), /PROFILE_STAGE_REACHED/)
  assert.deepEqual(probes, [62580])
})

test('a stale resolved Bonjour port still falls back to the full dynamic range', async () => {
  const { api, probes, opened } = reader(50007, { Bonjour: {
    browse: options => { queueMicrotask(() => options.onFound({ name: 'stale-device' })); return { stop() {} } },
    resolve: async () => ({ port: 62580, txtRecord: {} }),
  }, queueMicrotask })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.ok(probes.includes(62580))
  assert.deepEqual(opened, [50007])
})

test('LocalDevVPN can be enabled without starting or replacing the external VPN', async () => {
  const enabled = []
  const { api } = reader(62554, { VPN: {
    start() { throw new Error('must not start a different VPN') },
    localDevVPN: {
      getState: async () => ({ enabled: false, expectedState: 'current-config', effectiveStatus: 'inactive' }),
      setEnabled: async (value, options) => { enabled.push([value, options.expectedState]) },
    },
  } })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.deepEqual(enabled, [[true, 'current-config']])
})

test('a VPN state conflict does not block a reachable external route', async () => {
  const { api } = reader(62554, { VPN: { localDevVPN: {
    getState: async () => { throw new Error('configuration changed') },
  } } })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
})

test('Bonjour ignores an identity tag from a different paired device', async () => {
  const { authTag } = loadTs('lib/rpp/siphash.ts')
  const wrongTag = authTag(new Uint8Array(16).fill(1), 'other-device')
  const { api, probes } = reader(50007, { Bonjour: {
    browse: options => { queueMicrotask(() => options.onFound({ name: 'other-device' })); return { stop() {} } },
    resolve: async () => ({ port: 62580, txtRecord: { authTag: new TextEncoder().encode(wrongTag) } }),
  }, queueMicrotask })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.ok(!probes.includes(62580))
})

test('Bonjour accepts the paired device identity tag', async () => {
  const { authTag } = loadTs('lib/rpp/siphash.ts')
  const tag = authTag(new Uint8Array(16), 'paired-device')
  const { api, opened } = reader(62580, { Bonjour: {
    browse: options => { queueMicrotask(() => options.onFound({ name: 'paired-device' })); return { stop() {} } },
    resolve: async () => ({ port: 62580, txtRecord: { authTag: new TextEncoder().encode(tag) } }),
  }, queueMicrotask })
  await assert.rejects(api.readExpiryViaRpp('10.7.0.1', 62554), /PROFILE_STAGE_REACHED/)
  assert.deepEqual(opened, [62580])
})

test('zero address is rejected after IPv4 normalization', async () => {
  const { api, probes } = reader(62554)
  await assert.rejects(api.readExpiryViaRpp('00.0.0.0', 62554), /IP|IPv4/)
  assert.equal(probes.length, 0)
})
