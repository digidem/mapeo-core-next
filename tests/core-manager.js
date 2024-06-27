import test from 'node:test'
import { access, constants } from 'node:fs/promises'
import { pEvent } from 'p-event'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import Hypercore from 'hypercore'
import RAM from 'random-access-memory'
import { createCoreManager, replicate } from './helpers/core-manager.js'
import { randomBytes } from 'crypto'
import Sqlite from 'better-sqlite3'
import { KeyManager } from '@mapeo/crypto'
import {
  CoreManager,
  kCoreManagerReplicate,
} from '../src/core-manager/index.js'
import RemoteBitfield from '../src/core-manager/remote-bitfield.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { temporaryDirectoryTask } from 'tempy'
import { exec } from 'child_process'
import { RandomAccessFilePool } from '../src/core-manager/random-access-file-pool.js'
import RandomAccessFile from 'random-access-file'
import path from 'path'
import { Transform } from 'streamx'
import { waitForCores } from './helpers/core-manager.js'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { coresTable } from '../src/schema/project.js'
import { eq } from 'drizzle-orm'
/** @typedef {import('../src/constants.js').NAMESPACES[number]} Namespace */

/** @param {any} [key] */
async function createCore(key) {
  const core = new Hypercore(() => new RAM(), key)
  await core.ready()
  return core
}

test('project creator auth core has project key', async function () {
  const keyManager = new KeyManager(randomBytes(16))
  const { publicKey: projectKey, secretKey: projectSecretKey } =
    keyManager.getHypercoreKeypair('auth', randomBytes(32))

  const cm = createCoreManager({
    keyManager,
    storage: () => new RAM(),
    projectKey,
    projectSecretKey,
  })
  const { key: authCoreKey } = cm.getWriterCore('auth')
  assert(authCoreKey.equals(projectKey))
})

test('getCreatorCore()', async () => {
  const projectKey = randomBytes(32)
  const cm = createCoreManager({ projectKey })
  await cm.creatorCore.ready()
  assert(cm.creatorCore.key.equals(projectKey))
})

test('eagerly updates remote bitfields', async () => {
  // Replication progress relies on the peer.remoteBitfield to actually match
  // the bitfield of the peer. By default hypercore only updates the
  // remoteBitfield for the ranges of a hypercore that you try to download. We
  // "hack" hypercore to get the bitfield for the whole core, and this test
  // checks that functionality.

  const projectKey = randomBytes(32)
  const cm1 = createCoreManager({ projectKey })
  const cm2 = createCoreManager({ projectKey })
  const cm3 = createCoreManager({ projectKey })

  const cm1Core = cm1.getWriterCore('auth').core
  await cm1Core.ready()
  await cm1Core.append(['a', 'b', 'c', 'd', 'e'])
  // Hypercore only shares the contiguous length on initial handshake, not the
  // whole bitfield, so we need to test replicating a bitfield with
  // contiguousLength < length
  await cm1Core.clear(2, 3)

  const destroyReplication = replicate(cm1, cm2).destroy

  await waitForCores(cm2, [cm1Core.key])
  const cm2Core = cm2.getCoreByKey(cm1Core.key)
  assert(cm2Core, 'writer core has replicated')

  // Need to wait for now, since no event for when a remote bitfield is updated
  await new Promise((res) => setTimeout(res, 200))

  assert.equal(cm2Core.length, cm1Core.length)

  {
    assert(cm1Core.core)
    // This is testing that the remote bitfield is a duplicate of the bitfield
    // on the core that is being replicated, prior to calling core.download()
    assert(
      bitfieldEquals(
        cm2Core.peers[0].remoteBitfield,
        cm1Core.core.bitfield,
        cm1Core.length
      ),
      'remote bitfield is same as source bitfield'
    )
  }

  // replicate the (sparse) data and then clear data on the writer
  await cm2Core
    .download({ start: 0, end: cm2Core.length, ifAvailable: true })
    .done()
  await destroyReplication()
  await cm1Core.clear(0, 2)
  {
    // This is ensuring that bitfields also get propogated in the other
    // direction, e.g. from the non-writer to the writer
    const { destroy } = replicate(cm1, cm2)
    // Need to wait for now, since no event for when a remote bitfield is updated
    await new Promise((res) => setTimeout(res, 200))
    assert(cm2Core.core)
    assert(
      bitfieldEquals(
        cm1Core.peers[0].remoteBitfield,
        cm2Core.core.bitfield,
        cm1Core.length
      ),
      'remote bitfield on writer matches bitfield from replica'
    )
    await destroy()
  }

  {
    // cm3 is not connected directly to cm1. Important to catch edge case of
    // propertly propagating updates to remoteBitfield between peers that are
    // not directly connected
    replicate(cm1, cm2)
    replicate(cm2, cm3)

    await new Promise((res) => setTimeout(res, 200))

    const cm3Core = cm3.getCoreByKey(cm1Core.key)
    assert(cm3Core)
    assert.deepEqual(cm3Core.length, cm1Core.length)

    assert(
      bitfieldEquals(
        cm3Core.peers[0].remoteBitfield,
        cm2Core.core.bitfield,
        cm2Core.length
      ),
      'remote bitfield updated via indirect replication'
    )

    await cm1Core.append(['f', 'g', 'h', 'i', 'j'])
    await cm1Core.append(['k', 'l', 'm', 'o', 'p'])
    await cm2Core.download({ start: 9, end: 12 }).done()

    await new Promise((res) => setTimeout(res, 200))

    assert.deepEqual(cm3Core.length, cm1Core.length)
    assert(
      bitfieldEquals(
        cm3Core.peers[0].remoteBitfield,
        cm2Core.core.bitfield,
        cm2Core.length
      ),
      'remote bitfield updated via indirect replication'
    )
  }
})

test('multiplexing waits for cores to be added', async () => {
  // Mapeo code expects replication to work when cores are not added to the
  // replication stream at the same time. This is not explicitly tested in
  // Hypercore so we check here that this behaviour works.
  const a1 = await createCore()
  const a2 = await createCore()

  const b1 = await createCore(a1.key)
  const b2 = await createCore(a2.key)

  const n1 = new NoiseSecretStream(true)
  const n2 = new NoiseSecretStream(false)
  n1.rawStream.pipe(n2.rawStream).pipe(n1.rawStream)

  const stream1 = Hypercore.createProtocolStream(n1)
  const stream2 = Hypercore.createProtocolStream(n2)

  a1.replicate(stream1, { keepAlive: false })
  a2.replicate(stream1, { keepAlive: false })

  await a1.append('hi')
  await a2.append('ho')

  setTimeout(() => {
    b1.replicate(stream2, { keepAlive: false })
    b2.replicate(stream2, { keepAlive: false })
  }, 7000)

  assert.deepEqual(await b1.get(0), Buffer.from('hi'))
  assert.deepEqual(await b2.get(0), Buffer.from('ho'))
})

test('close()', async () => {
  const cm = createCoreManager()
  for (const namespace of CoreManager.namespaces) {
    cm.addCore(randomBytes(32), namespace)
  }
  await cm.close()
  for (const namespace of CoreManager.namespaces) {
    for (const { core } of cm.getCores(namespace)) {
      assert(core.closed, 'core is closed')
      assert.equal(core.sessions.length, 0, 'no open sessions')
    }
  }
})

test('Added cores are persisted', async () => {
  const keyManager = new KeyManager(randomBytes(16))
  const projectKey = randomBytes(32)

  const db = drizzle(new Sqlite(':memory:'))

  const cm1 = createCoreManager({
    db,
    keyManager,
    storage: () => new RAM(),
    projectKey,
  })
  const key = randomBytes(32)
  cm1.addCore(key, 'auth')

  await cm1.close()

  const cm2 = createCoreManager({
    db,
    keyManager,
    storage: () => new RAM(),
    projectKey,
  })

  assert(cm2.getCoreByKey(key), 'Added core is persisted')
})

test('encryption', async () => {
  /** @type {Partial<Record<Namespace, Buffer>>} */
  const encryptionKeys = {}
  for (const ns of CoreManager.namespaces) {
    encryptionKeys[ns] = randomBytes(32)
  }
  const projectKey = randomBytes(32)
  const cm1 = createCoreManager({ projectKey, encryptionKeys })
  const cm2 = createCoreManager({ projectKey })
  const cm3 = createCoreManager({ projectKey, encryptionKeys })

  replicate(cm1, cm2)
  replicate(cm1, cm3)

  for (const ns of CoreManager.namespaces) {
    const { core, key } = cm1.getWriterCore(ns)
    const { core: coreReplica2 } = cm2.addCore(key, ns)
    const { core: coreReplica3 } = cm3.addCore(key, ns)
    const value = Buffer.from(ns)
    await core.append(value)
    assert.notDeepEqual(await coreReplica2.get(0), value)
    assert.deepEqual(await coreReplica3.get(0), value)
  }
})

test('poolSize limits number of open file descriptors', async () => {
  const keyManager = new KeyManager(randomBytes(16))
  const { publicKey: projectKey, secretKey: projectSecretKey } =
    keyManager.getHypercoreKeypair('auth', randomBytes(32))

  const CORE_COUNT = 500
  await temporaryDirectoryTask(async (tempPath) => {
    /** @param {string} name */
    const storage = (name) => new RandomAccessFile(path.join(tempPath, name))
    const cm = createCoreManager({
      keyManager,
      storage,
      projectKey,
      projectSecretKey,
    })
    // -1 because CoreManager creates a writer core already
    for (let i = 0; i < CORE_COUNT - 1; i++) {
      const coreKey = randomBytes(32)
      cm.addCore(coreKey, 'data')
    }
    const readyPromises = cm.getCores('data').map(({ core }) => core.ready())
    assert.equal(readyPromises.length, CORE_COUNT)
    await Promise.all(readyPromises)
    const fdCount = await countOpenFileDescriptors(tempPath)
    assert(fdCount > CORE_COUNT, 'without pool, at least one fd per core')
  })

  await temporaryDirectoryTask(async (tempPath) => {
    const POOL_SIZE = 100
    const pool = new RandomAccessFilePool(POOL_SIZE)
    /** @param {string} name */
    const storage = (name) =>
      new RandomAccessFile(path.join(tempPath, name), { pool })
    const cm = createCoreManager({
      keyManager,
      storage,
      projectKey,
      projectSecretKey,
    })
    // -1 because we CoreManager creates a writer core already
    for (let i = 0; i < CORE_COUNT - 1; i++) {
      const coreKey = randomBytes(32)
      cm.addCore(coreKey, 'data')
    }
    const readyPromises = cm.getCores('data').map(({ core }) => core.ready())
    await Promise.all(readyPromises)
    const fdCount = await countOpenFileDescriptors(tempPath)
    assert.equal(
      fdCount,
      POOL_SIZE,
      'with pool, no more file descriptors than pool size'
    )
  })
})

test('sends "haves" bitfields over project creator core replication stream', async () => {
  const projectKey = randomBytes(32)
  const cm1 = createCoreManager({ projectKey })
  const cm2 = createCoreManager({ projectKey })
  /**
   * For each peer, indexed by peerId, a map of hypercore bitfields, indexed by discoveryId
   * @type {Map<string, Map<import('../src/core-manager/index.js').Namespace, Map<string, RemoteBitfield>>>}
   */
  const havesByPeer = new Map()

  cm2.on(
    'peer-have',
    (namespace, { coreDiscoveryId, peerId, start, bitfield }) => {
      let havesByNamespace = havesByPeer.get(peerId)
      if (!havesByNamespace) {
        havesByNamespace = new Map()
        havesByPeer.set(peerId, havesByNamespace)
      }
      let havesByCore = havesByNamespace.get(namespace)
      if (!havesByCore) {
        havesByCore = new Map()
        havesByNamespace.set(namespace, havesByCore)
      }
      let remoteBitfield = havesByCore.get(coreDiscoveryId)
      if (!remoteBitfield) {
        remoteBitfield = new RemoteBitfield()
        havesByCore.set(coreDiscoveryId, remoteBitfield)
      }
      remoteBitfield.insert(start, bitfield)
    }
  )

  const cm1Core = cm1.getWriterCore('data').core
  await cm1Core.ready()
  const batchSize = 4096
  // Create 4 million entries in hypercore - will be at least two have bitfields
  for (let i = 0; i < 2 ** 22; i += batchSize) {
    const data = Array(batchSize)
      .fill(null)
      .map(() => 'block')
    await cm1Core.append(data)
  }

  await cm1Core.clear(500, 30000)
  await cm1Core.clear(700000, 800000)

  const n1 = new NoiseSecretStream(true)
  const n2 = new NoiseSecretStream(false)
  n1.rawStream.pipe(n2.rawStream).pipe(n1.rawStream)

  cm1[kCoreManagerReplicate](n1)
  cm2[kCoreManagerReplicate](n2)

  // Need to wait for now, since no event for when a remote bitfield is updated
  await new Promise((res) => setTimeout(res, 200))

  const peerId = n1.publicKey?.toString('hex') || ''
  const havesByNamespace = havesByPeer.get(peerId)
  const havesByCore = havesByNamespace?.get('data')
  const bitfield = havesByCore?.get(cm1Core.discoveryKey?.toString('hex') || '')
  assert(bitfield)
  assert(cm1Core.core)

  assert(
    bitfieldEquals(bitfield, cm1Core.core.bitfield, cm1Core.length),
    'remote bitfield is same as source bitfield'
  )

  n1.destroy()
  n2.destroy()
  await Promise.all([once(n1, 'close'), once(n2, 'close')])
})

test('only sends "haves" bitfields when recipient is allowed to receive them', async (t) => {
  const projectKey = randomBytes(32)
  const cm1 = createCoreManager({
    projectKey,
    getSyncCapabilities: () =>
      Promise.resolve({
        auth: 'allowed',
        config: 'allowed',
        data: 'blocked',
        blobIndex: 'allowed',
        blob: 'blocked',
      }),
  })
  const cm2 = createCoreManager({ projectKey })

  const cm2ReceivedHavesForNamespaces = new Set()
  const cm2ReceivedHavesPromise = pEvent(cm2, 'peer-have', (namespace) => {
    cm2ReceivedHavesForNamespaces.add(namespace)
    return (
      cm2ReceivedHavesForNamespaces.has('auth') &&
      cm2ReceivedHavesForNamespaces.has('config')
    )
  })

  const namespaces = /** @type {const} */ (['auth', 'blob', 'config', 'data'])
  await Promise.all(
    namespaces.map(async (namespace) => {
      const cm1Core = cm1.getWriterCore(namespace).core
      await cm1Core.ready()
      await cm1Core.append(['block'])
    })
  )

  const n1 = new NoiseSecretStream(true)
  const n2 = new NoiseSecretStream(false)
  t.after(async () => {
    const closedPromise = Promise.all([once(n1, 'close'), once(n2, 'close')])
    n1.destroy()
    n2.destroy()
    await closedPromise
  })

  n1.rawStream.pipe(n2.rawStream).pipe(n1.rawStream)
  cm1[kCoreManagerReplicate](n1)
  cm2[kCoreManagerReplicate](n2)

  await cm2ReceivedHavesPromise

  assert.deepEqual(
    cm2ReceivedHavesForNamespaces,
    new Set(['auth', 'config']),
    'only allowed namespace "haves" are sent'
  )
})

test('unreplicate', async (t) => {
  const WAIT_TIMEOUT = 200
  const REPLICATION_DELAY = 20
  await t.test('initiator unreplicates, receiver re-replicates', async () => {
    const a = await createCore()
    await a.append(['a', 'b'])
    const b = await createCore(a.key)

    const [s1, s2] = replicateCores(a, b, { delay: REPLICATION_DELAY })

    const block1 = await b.get(0, { timeout: WAIT_TIMEOUT })
    assert.equal(block1?.toString(), 'a')

    await unreplicate(a, s1.noiseStream.userData)

    await assert.rejects(
      () => b.get(1, { timeout: WAIT_TIMEOUT }),
      'Throws with timeout error'
    )

    b.replicate(s2)

    const block2 = await b.get(1, { timeout: WAIT_TIMEOUT })
    assert.equal(block2?.toString(), 'b')
  })
  await t.test('initiator unreplicates, initiator re-replicates', async () => {
    const a = await createCore()
    await a.append(['a', 'b'])
    const b = await createCore(a.key)

    const [s1] = replicateCores(a, b, { delay: REPLICATION_DELAY })

    const block1 = await b.get(0, { timeout: WAIT_TIMEOUT })
    assert.equal(block1?.toString(), 'a')

    await unreplicate(a, s1.noiseStream.userData)

    await assert.rejects(
      () => b.get(1, { timeout: 200 }),
      'Throws with timeout error'
    )

    a.replicate(s1)

    const block2 = await b.get(1, { timeout: WAIT_TIMEOUT })
    assert.equal(block2?.toString(), 'b')
  })
  await t.test('receiver unreplicates, receiver re-replicates', async () => {
    const a = await createCore()
    await a.append(['a', 'b'])
    const b = await createCore(a.key)

    const [, s2] = replicateCores(a, b, { delay: REPLICATION_DELAY })

    const block1 = await b.get(0, { timeout: WAIT_TIMEOUT })
    assert.equal(block1?.toString(), 'a')

    await unreplicate(b, s2.noiseStream.userData)

    await assert.rejects(
      () => b.get(1, { timeout: WAIT_TIMEOUT }),
      'Throws with timeout error'
    )

    b.replicate(s2)

    const block2 = await b.get(1, { timeout: WAIT_TIMEOUT })
    assert.equal(block2?.toString(), 'b')
  })
})

test('deleteOthersData()', async () => {
  await temporaryDirectoryTask(async (tempPath) => {
    const projectKey = randomBytes(32)

    /** @type {Array<string>} */
    const storageNames = []

    const peer1TempPath = path.join(tempPath, 'peer1')

    /// Set up core managers
    const db1 = drizzle(new Sqlite(':memory:'))
    const cm1 = createCoreManager({
      db: db1,
      projectKey,
      storage: (name) => {
        storageNames.push(name)
        return new RandomAccessFile(path.join(peer1TempPath, name))
      },
      autoDownload: true,
    })

    const db2 = drizzle(new Sqlite(':memory:'))
    const cm2 = createCoreManager({
      db: db2,
      projectKey,
      storage: (name) => {
        return new RandomAccessFile(path.join(tempPath, 'peer2', name))
      },
      // We're only checking the filesystem for peer 1 so can avoid downloading for peer 2
      autoDownload: false,
    })

    /// Write data
    const dataWriter1 = cm1.getWriterCore('data')
    const dataWriter2 = cm2.getWriterCore('data')

    await dataWriter1.core.ready()
    await dataWriter2.core.ready()

    await dataWriter1.core.append(
      Array(100)
        .fill(null)
        .map((_, i) => 'block' + i)
    )

    await dataWriter2.core.append(
      Array(50)
        .fill(null)
        .map((_, i) => 'block' + i)
    )

    /// Replicate
    const n1 = new NoiseSecretStream(true)
    const n2 = new NoiseSecretStream(false)
    n1.rawStream.pipe(n2.rawStream).pipe(n1.rawStream)
    cm1[kCoreManagerReplicate](n1)
    cm2[kCoreManagerReplicate](n2)

    // This delay is needed in order for replication to finish properly
    await new Promise((res) => setTimeout(res, 200))

    /// Confirmation to ensure that replication worked
    assert.equal(
      cm1.getCores('data').length,
      2,
      'peer 1 has expected number of data cores after replication'
    )

    const peer1DataCoreStoragePath = getCoreStoragePath(
      // @ts-expect-error
      dataWriter1.core.discoveryKey.toString('hex')
    )

    const peer2DataCoreStoragePath = getCoreStoragePath(
      // @ts-expect-error
      dataWriter2.core.discoveryKey.toString('hex')
    )

    const dataCoreStorageNames = storageNames.filter(
      (name) =>
        name.startsWith(peer1DataCoreStoragePath) ||
        name.startsWith(peer2DataCoreStoragePath)
    )

    // Hypercore uses 4 files per core (oplog, tree, bitfield, data)
    assert.equal(
      dataCoreStorageNames.length,
      8,
      'peer 1 has expected number of data core storage files after replication'
    )

    assert.equal(
      db1
        .select()
        .from(coresTable)
        .where(eq(coresTable.namespace, 'data'))
        .all().length,
      1,
      'peer 1 `cores` table has info about `data` core from peer 2'
    )

    assert.equal(
      db2
        .select()
        .from(coresTable)
        .where(eq(coresTable.namespace, 'data'))
        .all().length,
      1,
      'peer 2 `cores` table has info about `data` core from peer 1'
    )

    /// Delete data (not their own)
    await cm1.deleteOthersData('data')

    const peer1DataStoragePreservedForPeer1 = (
      await checkExistenceForFiles(
        dataCoreStorageNames
          .filter((storageName) =>
            storageName.startsWith(peer1DataCoreStoragePath)
          )
          .map((storageName) => path.join(peer1TempPath, storageName))
      )
    ).every((exists) => exists === true)

    const peer2DataStorageDeletedForPeer1 = (
      await checkExistenceForFiles(
        dataCoreStorageNames
          .filter((storageName) =>
            storageName.startsWith(peer2DataCoreStoragePath)
          )
          .map((storageName) => path.join(peer1TempPath, storageName))
      )
    ).every((exists) => exists === false)

    assert(
      peer1DataStoragePreservedForPeer1,
      'peer 1 still has `data` storage for itself'
    )

    assert(
      peer2DataStorageDeletedForPeer1,
      'peer 1 no longer has `data` storage for peer 2'
    )

    assert.equal(
      db1
        .select()
        .from(coresTable)
        .where(eq(coresTable.namespace, 'data'))
        .all().length,
      0,
      'peer 1 `cores` table has no info about `data` core from peer 2'
    )

    n1.destroy()
    n2.destroy()
    await Promise.all([once(n1, 'close'), once(n2, 'close')])
  })
})

const DEBUG = process.env.DEBUG

/**
 * Compare two bitfields (instance of core.core.bitfield or peer.remoteBitfield)
 * Need to pass len, since bitfields don't know their own length
 *
 * @param {{ get(index: number): unknown }} actual
 * @param {{ get(index: number): unknown }} expected
 * @param {number} len
 * @returns {boolean}
 */
function bitfieldEquals(actual, expected, len) {
  assert(typeof len === 'number')
  let actualStr = ''
  let expectedStr = ''
  for (let i = 0; i < len; i++) {
    const actualBit = actual.get(i)
    const expectedBit = expected.get(i)
    if (DEBUG) {
      // This will cause memory issues for large bitfields, so only do for debug
      actualStr += actualBit ? '1' : '0'
      expectedStr += expectedBit ? '1' : '0'
    } else {
      if (actualBit !== expectedBit) return false
    }
  }
  if (DEBUG) {
    if (actualStr === expectedStr) {
      console.log(`bitfield as expected: '${expectedStr}'`)
      return true
    } else {
      console.error(`expected '${expectedStr}', but got '${actualStr}'`)
      return false
    }
  } else {
    return true
  }
}

/**
 * Count the open file descriptors in a given folder
 *
 * @param {string} dir folder for counting open file descriptors
 * @returns {Promise<number>}
 */
async function countOpenFileDescriptors(dir) {
  return new Promise((res, rej) => {
    exec(`lsof +D '${dir}' | wc -l`, (error, stdout) => {
      if (error) return rej(error)
      res(Number(stdout) - 1)
    })
  })
}

/**
 * @param {Hypercore} a
 * @param {Hypercore} b
 * @param {Parameters<typeof Hypercore.prototype.replicate>[1] & { delay?: number }} [opts]
 * @returns
 */
function replicateCores(a, b, { delay = 0, ...opts } = {}) {
  const s1 = a.replicate(true, { keepAlive: false, ...opts })
  const s2 = b.replicate(false, { keepAlive: false, ...opts })
  s1.pipe(latencyStream(delay)).pipe(s2).pipe(latencyStream(delay)).pipe(s1)
  return [s1, s2]
}

/**
 * Randomly delay stream chunks by up to `delay` milliseconds
 * @param {number} delay
 * @returns
 */
function latencyStream(delay = 0) {
  return new Transform({
    transform(data, callback) {
      setTimeout(callback, Math.random() * delay, null, data)
    },
  })
}

/**
 *
 * @param {Hypercore<'binary', any>} core
 * @param {import('protomux')} protomux
 */
export function unreplicate(core, protomux) {
  const peerToUnreplicate = core.peers.find(
    (peer) => peer.protomux === protomux
  )
  if (!peerToUnreplicate) return
  peerToUnreplicate.channel.close()
  return
}

/**
 * From https://github.com/holepunchto/corestore/blob/v6.8.4/index.js#L240
 *
 * @param {string} id Core discovery key as hex string
 */
function getCoreStoragePath(id) {
  return ['cores', id.slice(0, 2), id.slice(2, 4), id].join('/')
}

/**
 * @param {Array<string>} files
 * @returns {Promise<Array<boolean>>} Promise that resolves with array of results, where `true` means the file exists and `false` means it does not exist
 */
async function checkExistenceForFiles(files) {
  return Promise.all(
    files.map((filePath) =>
      access(filePath, constants.F_OK)
        .then(() => true)
        .catch(() => false)
    )
  )
}
