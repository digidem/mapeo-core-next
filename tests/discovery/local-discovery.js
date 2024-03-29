import test from 'brittle'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { KeyManager } from '@mapeo/crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pDefer from 'p-defer'
import { keyToPublicId } from '@mapeo/crypto'
import {
  ERR_DUPLICATE,
  LocalDiscovery,
} from '../../src/discovery/local-discovery.js'
import NoiseSecretStream from '@hyperswarm/secret-stream'

test('mdns - discovery and sharing of data', (t) => {
  const deferred = pDefer()
  const identityKeypair1 = new KeyManager(randomBytes(16)).getIdentityKeypair()
  const identityKeypair2 = new KeyManager(randomBytes(16)).getIdentityKeypair()

  const mdnsDiscovery1 = new LocalDiscovery({
    identityKeypair: identityKeypair1,
  })
  const mdnsDiscovery2 = new LocalDiscovery({
    identityKeypair: identityKeypair2,
  })
  const str = 'hi'

  mdnsDiscovery1.on('connection', (stream) => {
    stream.on('error', handleConnectionError.bind(null, t))
    stream.write(str)
  })

  mdnsDiscovery2.on('connection', (stream) => {
    stream.on('error', handleConnectionError.bind(null, t))
    stream.on('data', (d) => {
      t.is(d.toString(), str, 'expected data written')
      Promise.all([
        mdnsDiscovery1.stop({ force: true }),
        mdnsDiscovery2.stop({ force: true }),
      ]).then(() => {
        t.pass('teardown complete')
        deferred.resolve()
      })
    })
  })

  mdnsDiscovery1.start()
  mdnsDiscovery2.start()

  return deferred.promise
})

test('deduplicate incoming connections', async (t) => {
  const localConnections = new Set()
  const remoteConnections = new Set()

  const localKp = new KeyManager(randomBytes(16)).getIdentityKeypair()
  const remoteKp = new KeyManager(randomBytes(16)).getIdentityKeypair()
  const discovery = new LocalDiscovery({ identityKeypair: localKp })
  await discovery.start()

  discovery.on('connection', (conn) => {
    conn.on('error', handleConnectionError.bind(null, t))
    localConnections.add(conn)
    conn.on('close', () => localConnections.delete(conn))
  })

  const addrInfo = discovery.address()
  for (let i = 0; i < 20; i++) {
    noiseConnect(addrInfo, remoteKp).then((conn) => {
      conn.on('error', handleConnectionError.bind(null, t))
      conn.on('connect', () => remoteConnections.add(conn))
      conn.on('close', () => remoteConnections.delete(conn))
    })
  }

  await delay(1000)
  t.is(localConnections.size, 1)
  t.is(remoteConnections.size, 1)
  t.alike(
    localConnections.values().next().value.handshakeHash,
    remoteConnections.values().next().value.handshakeHash
  )
  await discovery.stop({ force: true })
})

test(`mdns - discovery of 30 peers with random time instantiation`, async (t) => {
  await testMultiple(t, { period: 2000, nPeers: 30 })
})

test(`mdns - discovery of 30 peers instantiated at the same time`, async (t) => {
  await testMultiple(t, { period: 0, nPeers: 30 })
})

/**
 *
 * @param {net.AddressInfo} addrInfo
 * @param {{ publicKey: Buffer, secretKey: Buffer }} keyPair
 * @returns
 */
async function noiseConnect({ port, address }, keyPair) {
  const socket = net.connect(port, address)
  return new NoiseSecretStream(true, socket, { keyPair })
}

/**
 * @param {any} t
 * @param {object} opts
 * @param {number} opts.period Randomly spawn peers within this period
 * @param {number} [opts.nPeers] Number of peers to spawn (default 20)
 */
async function testMultiple(t, { period, nPeers = 20 }) {
  const peersById = new Map()
  const connsById = new Map()
  const promises = []
  // t.plan(3 * nPeers + 1)

  async function spawnPeer(onConnected) {
    const identityKeypair = new KeyManager(randomBytes(16)).getIdentityKeypair()
    const discovery = new LocalDiscovery({ identityKeypair })
    const peerId = keyToPublicId(discovery.publicKey)
    peersById.set(peerId, discovery)
    const conns = []
    connsById.set(peerId, conns)
    discovery.on('connection', (conn) => {
      conn.on('error', handleConnectionError.bind(null, t))
      conns.push(conn)
      if (conns.length >= nPeers - 1) onConnected()
    })
    await discovery.start()
    return discovery
  }

  for (let p = 0; p < nPeers; p++) {
    const deferred = pDefer()
    promises.push(deferred.promise)
    setTimeout(spawnPeer, Math.floor(Math.random() * period), deferred.resolve)
  }

  // Wait for all peers to connect to at least nPeers - 1 peers (every other peer)
  await Promise.all(promises)
  // Wait another 1000ms for any deduplication
  await delay(1000)

  const peerIds = [...peersById.keys()]

  for (const peerId of peerIds) {
    const expected = peerIds.filter((id) => id !== peerId).sort()
    const actual = connsById
      .get(peerId)
      .filter((conn) => !conn.destroyed)
      .map((conn) => keyToPublicId(conn.remotePublicKey))
      .sort()
    t.alike(
      actual,
      expected,
      `peer ${peerId.slice(0, 7)} connected to all ${
        expected.length
      } other peers`
    )
  }

  const stopPromises = []
  for (const discovery of peersById.values()) {
    stopPromises.push(discovery.stop({ force: true }))
  }
  await Promise.all(stopPromises)
  t.pass('teardown complete')
}

function handleConnectionError(t, e) {
  // We expected connections to be closed when duplicates happen. On the
  // closing side the error will be ERR_DUPLICATE, but on the other side
  // the error will be an ECONNRESET - the error is not sent over the
  // connection
  const expectedError = e.message === ERR_DUPLICATE || e.code === 'ECONNRESET'
  t.ok(expectedError, 'connection closed with expected error')
}
