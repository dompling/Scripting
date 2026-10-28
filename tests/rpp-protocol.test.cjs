const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { webcrypto } = require('node:crypto')
const { loadTs } = require('./helpers/load-ts.cjs')

test('pair-verify identifies the host and preserves envelope sequence into createListener', async () => {
  // Native ChaCha is unavailable in Node; framing and the full pair-verify state machine run here.
  const crypto = {
    subtle: webcrypto.subtle,
    chacha20Poly1305: {
      encrypt: async (_, bytes) => bytes,
      decrypt: async (_, bytes) => bytes,
    },
  }
  const { PairVerifyClient } = loadTs('lib/rpp/pairverify.ts', {}, { crypto })
  const { StreamChannel } = loadTs('lib/rpp/stream.ts', {}, { crypto })
  const device = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const host = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const devicePublic = new Uint8Array(await webcrypto.subtle.exportKey('raw', device.publicKey))
  const sent = []
  const pairingData = bytes => ({ event: { _0: { pairingData: { _0: { data: Buffer.from(bytes).toString('base64') } } } } })
  const replies = [
    { response: { _1: { handshake: { _0: { wireProtocolVersion: 26 } } } } },
    pairingData(new Uint8Array([6, 1, 2, 3, 32, ...devicePublic])),
    pairingData(new Uint8Array([6, 1, 4])),
    { message: { streamEncrypted: { _0: Buffer.from(JSON.stringify({ response: { _1: { createListener: { port: 50370 } } } })).toString('base64') } } },
  ]
  const peer = {
    write: async bytes => sent.push(JSON.parse(Buffer.from(bytes.subarray(11)).toString())),
    read: async () => replies.shift(),
  }
  const verified = await new PairVerifyClient({ file: { identifier: 'test-host' }, signingKey: host.privateKey }, peer).run()
  const channel = await StreamChannel.connect(verified.preSharedKey, peer, verified.channel)
  assert.equal(await channel.createListener(verified.preSharedKey), 50370)
  assert.deepEqual(sent.map(frame => frame.originatedBy), ['host', 'host', 'host', 'host'])
  assert.deepEqual(sent.map(frame => frame.sequenceNumber), [0, 1, 2, 3])
  assert.equal(channel.exchangeCount, 1n)
})

function deviceFixture(failure, delayTunnel = 0, delayConnect = 0) {
  const events = []
  const socket = new EventEmitter()
  socket.destroy = () => { events.push('socket.close') }
  const control = { close: async () => { events.push('control.close') } }
  const tunnel = {
    getState: async () => {
      if (failure === 'state') throw new Error('state failed')
      return { rsdPort: 58783 }
    },
    connect: async () => {
      if (delayConnect) await new Promise(resolve => setTimeout(resolve, delayConnect))
      if (failure === 'connect') throw new Error('connect failed')
      return control
    },
    close: async () => { events.push('tunnel.close') },
  }
  const { openDeviceLink } = loadTs('lib/rsd/device.ts', {
    'node:net': { createConnection: () => { queueMicrotask(() => socket.emit('connect')); return socket } },
    '../rpp': {
      PairStore: class {},
      SocketPeer: class {},
      PairVerifyClient: class { async run() { if (failure === 'pair') throw new Error('pair failed'); return { preSharedKey: new Uint8Array(32) } } },
      StreamChannel: { connect: async () => ({ createListener: async () => { if (failure === 'listener') throw new Error('listener failed'); return 50370 } }) },
    },
    '../util': { randomBytes: count => new Uint8Array(count) },
    './rsd': {
      RsdClient: { connect: async () => { if (failure === 'handshake') throw new Error('handshake failed'); return { services: new Map([['test', { port: 12345 }]]) } } },
      requireService: (handshake, name) => handshake.services.get(name),
    },
    './stream': { TunnelStream: class { constructor(connection) { this.connection = connection } async close() { await this.connection.close() } } },
  }, {
    VPN: { localDevVPN: { openRSDTunnel: async () => {
      if (delayTunnel) await new Promise(resolve => setTimeout(resolve, delayTunnel))
      if (failure === 'tunnel') throw new Error('tunnel failed')
      return tunnel
    } } },
  })
  return {
    events,
    open: (stepTimeoutMs = 100) => openDeviceLink({ address: '10.7.0.1', stepTimeoutMs, credentials: { file: {}, signingKey: {} } }),
  }
}

test('RSD control is freed while pairing remains alive until DeviceLink.close', async () => {
  const fixture = deviceFixture()
  const link = await fixture.open()
  assert.deepEqual(fixture.events, ['control.close'])
  await link.open('test')
  assert.deepEqual(fixture.events, ['control.close'])
  await link.close()
  assert.deepEqual(fixture.events, ['control.close', 'tunnel.close', 'socket.close'])
})

for (const failure of ['pair', 'listener', 'tunnel', 'state', 'connect', 'handshake']) {
  test(`failed ${failure} step releases pairing and any opened tunnel`, async () => {
    const fixture = deviceFixture(failure)
    await assert.rejects(fixture.open(), new RegExp(`${failure} failed`))
    assert.equal(fixture.events.filter(event => event === 'socket.close').length, 1)
    assert.equal(fixture.events.includes('tunnel.close'), ['state', 'connect', 'handshake'].includes(failure))
    assert.equal(fixture.events.includes('control.close'), failure === 'handshake')
  })
}

test('native tunnel completing after the deadline is closed', async () => {
  const fixture = deviceFixture(undefined, 25)
  await assert.rejects(fixture.open(5), /timed out/)
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(fixture.events.filter(event => event === 'tunnel.close').length, 1)
  assert.equal(fixture.events.filter(event => event === 'socket.close').length, 1)
})

test('native control connection completing after the deadline is closed', async () => {
  const fixture = deviceFixture(undefined, 0, 25)
  await assert.rejects(fixture.open(5), /timed out/)
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(fixture.events.filter(event => event === 'control.close').length, 1)
  assert.equal(fixture.events.filter(event => event === 'tunnel.close').length, 1)
  assert.equal(fixture.events.filter(event => event === 'socket.close').length, 1)
})
