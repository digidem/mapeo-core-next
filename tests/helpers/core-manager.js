import {
  CoreManager,
  kCoreManagerReplicate,
} from '../../src/core-manager/index.js'
import Sqlite from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { KeyManager } from '@mapeo/crypto'
import RAM from 'random-access-memory'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { COORDINATOR_ROLE_ID, ROLES } from '../../src/roles.js'
/** @typedef {(typeof import('../../src/constants.js').NAMESPACES)[number]} Namespace */

/**
 *
 * @param {Partial<ConstructorParameters<typeof CoreManager>[0]> & { rootKey?: Buffer }} param0
 * @returns
 */
export function createCoreManager({
  rootKey = randomBytes(16),
  projectKey = randomBytes(32),
  db = drizzle(new Sqlite(':memory:')),
  ...opts
} = {}) {
  migrate(db, {
    migrationsFolder: new URL('../../drizzle/project', import.meta.url)
      .pathname,
  })

  const keyManager = new KeyManager(rootKey)

  return new CoreManager({
    db,
    keyManager,
    storage: () => new RAM(),
    projectKey,
    autoDownload: false,
    getRole: () => Promise.resolve(ROLES[COORDINATOR_ROLE_ID]),
    ...opts,
  })
}

/**
 * @param {import('streamx').Duplex} stream
 * @returns {Promise<void>}
 */
const destroyStream = (stream) =>
  new Promise((res) => {
    stream.on('close', res)
    stream.destroy()
  })

/**
 *
 * @param {CoreManager} cm1
 * @param {CoreManager} cm2
 * @param {{ kp1: import('../../src/types.js').KeyPair, kp2: import('../../src/types.js').KeyPair }} [opts]
 * @returns {{ destroy: () => Promise<void> }}
 */
export function replicate(
  cm1,
  cm2,
  { kp1, kp2 } = {
    kp1: NoiseSecretStream.keyPair(),
    kp2: NoiseSecretStream.keyPair(),
  }
) {
  /** @typedef {typeof NoiseSecretStream<import('streamx').Duplex>} DefaultSecretStream */
  const n1 = new /** @type {DefaultSecretStream} */ (NoiseSecretStream)(
    true,
    undefined,
    { keyPair: kp1 }
  )
  const n2 = new /** @type {DefaultSecretStream} */ (NoiseSecretStream)(
    false,
    undefined,
    { keyPair: kp2 }
  )
  n1.rawStream.pipe(n2.rawStream).pipe(n1.rawStream)

  cm1[kCoreManagerReplicate](n1)
  cm2[kCoreManagerReplicate](n2)

  return {
    async destroy() {
      await Promise.all([n1, n2].map(destroyStream))
    },
  }
}

/**
 * @param {CoreManager} coreManager
 * @param {ReadonlyArray<Buffer>} keys
 * @returns {Promise<void>}
 */
export async function waitForCores(coreManager, keys) {
  const allKeys = getAllKeys(coreManager)
  if (hasKeys(keys, allKeys)) return
  return new Promise((res) => {
    coreManager.on('add-core', async function onAddCore({ key, core }) {
      await core.ready()
      allKeys.push(key)
      if (hasKeys(keys, allKeys)) {
        coreManager.off('add-core', onAddCore)
        res()
      }
    })
  })
}

/**
 * @param {CoreManager} coreManager
 * @returns {Array<Buffer>}
 */
export function getAllKeys(coreManager) {
  return CoreManager.namespaces.flatMap((namespace) =>
    getKeys(coreManager, namespace)
  )
}

/**
 * @param {CoreManager} coreManager
 * @param {Namespace} namespace
 * @returns {Array<Buffer>}
 */
export function getKeys(coreManager, namespace) {
  return coreManager.getCores(namespace).map(({ key }) => key)
}

/**
 * @param {ReadonlyArray<Buffer>} someKeys
 * @param {ReadonlyArray<Buffer>} allKeys
 * @returns {boolean}
 */
export function hasKeys(someKeys, allKeys) {
  for (const key of someKeys) {
    if (!allKeys.find((k) => k.equals(key))) return false
  }
  return true
}
