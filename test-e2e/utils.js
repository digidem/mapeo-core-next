import sodium from 'sodium-universal'
import RAM from 'random-access-memory'
import Fastify from 'fastify'
import { arrayFrom } from 'iterpal'
import * as path from 'node:path'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as v8 from 'node:v8'
import { pEvent } from 'p-event'

import { MapeoManager, roles } from '../src/index.js'
import { kRPC } from '../src/mapeo-manager.js'
import { generate } from '@mapeo/mock-data'
import { valueOf } from '../src/utils.js'
import { randomBytes, randomInt } from 'node:crypto'
import { temporaryFile, temporaryDirectory } from 'tempy'
import fsPromises from 'node:fs/promises'
import { kSyncState } from '../src/sync/sync-api.js'
import { readConfig } from '../src/config-import.js'

const FAST_TESTS = !!process.env.FAST_TESTS
const projectMigrationsFolder = new URL('../drizzle/project', import.meta.url)
  .pathname
const clientMigrationsFolder = new URL('../drizzle/client', import.meta.url)
  .pathname

/**
 * @param {readonly MapeoManager[]} managers
 * @returns {() => Promise<void>}
 */
export function connectPeers(managers) {
  let requestedDisconnect = false

  for (const manager of managers) {
    manager.startLocalPeerDiscoveryServer().then(({ name, port }) => {
      if (requestedDisconnect) return
      for (const otherManager of managers) {
        if (otherManager === manager) continue
        otherManager.connectLocalPeer({ address: '127.0.0.1', name, port })
      }
    })
  }

  return async () => {
    requestedDisconnect = true
    await Promise.all(
      managers.map((manager) =>
        manager.stopLocalPeerDiscoveryServer({ force: true })
      )
    )
  }
}

/**
 * Invite mapeo clients to a project
 *
 * @param {{
 *   invitor: MapeoManager,
 *   projectId: string,
 *   invitees: MapeoManager[],
 *   roleId?: import('../src/roles.js').RoleIdAssignableToOthers,
 *   roleName?: string
 *   reject?: boolean
 * }} opts
 */
export async function invite({
  invitor,
  projectId,
  invitees,
  roleId = roles.MEMBER_ROLE_ID,
  roleName,
  reject = false,
}) {
  const invitorProject = await invitor.getProject(projectId)

  /** @type {Array<Promise<unknown>>} */
  const promises = []

  for (const invitee of invitees) {
    const inviteId = randomBytes(32)
    promises.push(
      invitorProject.$member.invite(invitee.deviceId, {
        roleId,
        roleName,
        __testOnlyInviteId: inviteId,
      })
    )
    promises.push(
      (async () => {
        const invite = await pEvent(
          invitee.invite,
          'invite-received',
          (invite) => Buffer.from(invite.inviteId, 'hex').equals(inviteId)
        )
        await (reject
          ? invitee.invite.reject(invite)
          : invitee.invite.accept(invite))
      })()
    )
  }

  await Promise.allSettled(promises)
}

/**
 * Waits for all manager instances to be connected to each other
 *
 * @param {readonly MapeoManager[]} managers
 * @param {{ waitForDeviceInfo?: boolean }} [opts] Optionally wait for device names to be set
 * @returns {Promise<void>}
 */
export const waitForPeers = (managers, { waitForDeviceInfo = false } = {}) =>
  new Promise((res) => {
    const expectedCount = managers.length - 1
    const isDone = () =>
      managers.every((manager) => {
        const { peers } = manager[kRPC]
        const connectedPeers = peers.filter(
          ({ status }) => status === 'connected'
        )
        return (
          connectedPeers.length === expectedCount &&
          (!waitForDeviceInfo || connectedPeers.every(({ name }) => !!name))
        )
      })

    if (isDone()) {
      res()
      return
    }

    const onLocalPeers = () => {
      if (isDone()) {
        for (const manager of managers) manager.off('local-peers', onLocalPeers)
        res()
      }
    }

    for (const manager of managers) manager.on('local-peers', onLocalPeers)
  })

/**
 * Create `count` manager instances. Each instance has a deterministic identity
 * keypair so device IDs should be consistent between tests.
 *
 * @template {number} T
 * @param {T} count
 * @param {import('node:test').TestContext} t
 * @param {import('../src/generated/rpc.js').DeviceInfo['deviceType']} [deviceType]
 * @returns {Promise<import('type-fest').ReadonlyTuple<MapeoManager, T>>}
 */
export async function createManagers(
  count,
  t,
  deviceType = 'device_type_unspecified'
) {
  // @ts-ignore
  return Promise.all(
    Array(count)
      .fill(null)
      .map(async (_, i) => {
        const name = 'device' + i + (deviceType ? `-${deviceType}` : '')
        const manager = createManager(name, t)
        await manager.setDeviceInfo({ name, deviceType })
        return manager
      })
  )
}

/**
 * @param {string} seed
 * @param {import('node:test').TestContext} t
 * @param {Partial<ConstructorParameters<typeof MapeoManager>[0]>} [overrides]
 */
export function createManager(seed, t, overrides = {}) {
  /** @type {string} */ let dbFolder
  /** @type {string | import('../src/types.js').CoreStorage} */ let coreStorage

  if (FAST_TESTS) {
    dbFolder = ':memory:'
    coreStorage = () => new RAM()
  } else {
    const directories = [temporaryDirectory(), temporaryDirectory()]
    ;[dbFolder, coreStorage] = directories
    t.after(() =>
      Promise.all(
        directories.map((dir) =>
          fsPromises.rm(dir, {
            recursive: true,
            force: true,
            maxRetries: 2,
          })
        )
      )
    )
  }

  return new MapeoManager({
    rootKey: getRootKey(seed),
    projectMigrationsFolder,
    clientMigrationsFolder,
    dbFolder,
    coreStorage,
    fastify: Fastify(),
    ...overrides,
  })
}

/**
 * `ManagerCustodian` helps you test the creation of multiple managers accessing
 * the same underlying files.
 *
 * For example, you might want to write a test like this:
 *
 * ```
 * const manager1 = createManager(persistedDataPath)
 * const projectId = await manager1.createProject('Foo')
 * manager1.close()
 *
 * const manager2 = createManager(persistedDataPath)
 * const project = await manager2.getProject(projectId)
 * assert(project, 'project can be loaded')
 * ```
 *
 * Unfortunately, this doesn't work because the only way to close a manager is
 * to close the process. `ManagerCustodian` makes it easier to create these
 * processes. You would rewrite the test like this:
 *
 * ```
 * const custodian = new ManagerCustodian(t)
 *
 * const projectId = custodian.withManagerInSeparateProcess((manager1) => (
 *   manager1.createProject('Foo')
 * ))
 *
 * const exists = custodian.withManagerInSeparateProcess(
 *   (manager2, projectId) =>
 *     Boolean(await manager2.getProject(projectId)),
 *   projectId
 * )
 * assert(exists, 'project exists')
 * ```
 *
 * If we ever offer a way to close a manager, we can remove this class.
 *
 * The name is deliberately a little obtuse because this class is a little
 * weird, and we want people to read the documentation.
 */
export class ManagerCustodian {
  #t
  #rootKey = getRootKey()
  #dbFolder = temporaryDirectory()
  #coreStorage = temporaryDirectory()

  /**
   * @param {import('node:test').TestContext} t
   */
  constructor(t) {
    this.#t = t
    for (const folder of [this.#dbFolder, this.#coreStorage]) {
      t.after(() =>
        fsPromises.rm(folder, { recursive: true, force: true, maxRetries: 2 })
      )
    }
  }

  /**
   * Run a function on a new manager in a separate process.
   *
   * Because this function is serialized and run in a separate process, there
   * are restrictions on the function:
   *
   * 1. Anything referenced outside the function must be passed as an argument.
   * 2. Arguments and return values must be serializable using `v8.serialize`.
   *
   * @template ArgsT
   * @template ResultT
   * @param {(manager: MapeoManager, ...args: ArgsT[]) => Promise<ResultT>} fn
   * @param {ArgsT[]} args
   * @returns {Promise<ResultT>}
   */
  async withManagerInSeparateProcess(fn, ...args) {
    const jsFile = await this.#createJsFile(fn, args)
    return this.#runJsFile(jsFile)
  }

  /**
   * @template ArgsT
   * @template ResultT
   * @param {(manager: MapeoManager, ...args: ArgsT[]) => Promise<ResultT>} fn
   * @param {ArgsT[]} args
   * @returns {Promise<string>}
   */
  async #createJsFile(fn, args) {
    // JSON.stringify does a good job wrapping strings in quotes and escaping.
    // This is a short alias.
    const s = JSON.stringify

    const require = createRequire(import.meta.url)
    const fastifyPath = require.resolve('fastify')

    const __filename = fileURLToPath(import.meta.url)
    const mapeoManagerJsPath = path.resolve(
      __filename,
      '..',
      '..',
      'src',
      'mapeo-manager.js'
    )
    const rootKeyHex = this.#rootKey.toString('hex')

    const argsHex = v8.serialize(args).toString('hex')

    const source = `
    import * as v8 from 'node:v8'
    import Fastify from ${s(fastifyPath)}
    import { MapeoManager } from ${s(mapeoManagerJsPath)}

    const manager = new MapeoManager({
      rootKey: Buffer.from(${s(rootKeyHex)}, 'hex'),
      projectMigrationsFolder: ${s(projectMigrationsFolder)},
      clientMigrationsFolder: ${s(clientMigrationsFolder)},
      dbFolder: ${s(this.#dbFolder)},
      coreStorage: ${s(this.#coreStorage)},
      fastify: Fastify(),
    })

    const fn = ${fn.toString()}

    const argsBuffer = Buffer.from(${s(argsHex)}, 'hex')
    const args = v8.deserialize(argsBuffer)

    const result = await fn(manager, ...args)

    process.send(result)
    `

    const result = temporaryFile({ extension: 'mjs' })
    this.#t.after(() => fsPromises.rm(result, { maxRetries: 2 }))
    await fsPromises.writeFile(result, source, 'utf8')
    return result
  }

  /**
   * @template ResultT
   * @param {string} jsFile
   * @returns {Promise<ResultT>}
   */
  #runJsFile(jsFile) {
    return new Promise((resolve, reject) => {
      /** @type {Error | ResultT} */
      let result = new Error('Child process finished without returning')

      const child = fork(jsFile, [], {
        cwd: process.cwd(),
        serialization: 'advanced',
        timeout: 60_000,
      })

      child.on('close', (code) => {
        if (code) {
          result = new Error(`Child process exited with code ${code}`)
        }
        if (result instanceof Error) {
          reject(result)
        } else {
          resolve(result)
        }
      })

      child.on('error', (err) => {
        result = err
      })

      child.on('message', (r) => {
        result = /** @type {ResultT} */ (r)
      })
    })
  }
}

/** @param {string} [seed] */
function getRootKey(seed) {
  const key = Buffer.allocUnsafe(16)
  if (!seed) {
    sodium.randombytes_buf(key)
  } else {
    const seedBuf = Buffer.alloc(32)
    sodium.crypto_generichash(seedBuf, Buffer.from(seed))
    sodium.randombytes_buf_deterministic(key, seedBuf)
  }
  return key
}

/**
 *
 * @param {number} value
 * @param {number} decimalPlaces
 */
export function round(value, decimalPlaces) {
  return Math.round(value * 10 ** decimalPlaces) / 10 ** decimalPlaces
}

/**
 * Unlike `mapeo.project.$sync.waitForSync` this also waits for the specified
 * number of peers to connect.
 *
 * @param {import('../src/mapeo-project.js').MapeoProject} project
 * @param {string[]} peerIds
 * @param {'initial' | 'full'} [type]
 */
async function waitForProjectSync(project, peerIds, type = 'initial') {
  const state = project.$sync[kSyncState].getState()
  if (hasPeerIds(state.auth.remoteStates, peerIds)) {
    return project.$sync.waitForSync(type)
  }
  return new Promise((res) => {
    project.$sync[kSyncState].on('state', function onState(state) {
      if (!hasPeerIds(state.auth.remoteStates, peerIds)) return
      project.$sync[kSyncState].off('state', onState)
      res(project.$sync.waitForSync(type))
    })
  })
}

/**
 * @param {Record<string, unknown>} remoteStates
 * @param {string[]} peerIds
 * @returns {boolean}
 */
function hasPeerIds(remoteStates, peerIds) {
  for (const peerId of peerIds) {
    if (!(peerId in remoteStates)) return false
  }
  return true
}

/**
 * Wait for all projects to connect and sync
 *
 * @param {import('../src/mapeo-project.js').MapeoProject[]} projects
 * @param {'initial' | 'full'} [type]
 */
export function waitForSync(projects, type = 'initial') {
  return Promise.all(
    projects.map((project) => {
      const peerIds = projects
        .filter((p) => p !== project)
        .map((p) => p.deviceId)
      return waitForProjectSync(project, peerIds, type)
    })
  )
}

/**
 * @param {import('../src/mapeo-project.js').MapeoProject[]} projects
 * @param {object} [opts]
 * @param {readonly import('@comapeo/schema').MapeoDoc['schemaName'][]} [opts.schemas]
 */
export function seedDatabases(projects, { schemas = SCHEMAS_TO_SEED } = {}) {
  return Promise.all(projects.map((p) => seedProjectDatabase(p, { schemas })))
}

const SCHEMAS_TO_SEED = /** @type {const} */ ([
  'observation',
  'preset',
  'field',
])

/**
 * @param {import('../src/mapeo-project.js').MapeoProject} project
 * @param {object} [opts]
 * @param {readonly import('@comapeo/schema').MapeoDoc['schemaName'][]} [opts.schemas]
 * @returns {Promise<Array<import('@comapeo/schema').MapeoDoc & { forks: string[] }>>}
 */
async function seedProjectDatabase(
  project,
  { schemas = SCHEMAS_TO_SEED } = {}
) {
  const promises = []
  for (const schemaName of schemas) {
    const count =
      schemaName === 'observation' ? randomInt(20, 100) : randomInt(0, 10)
    let i = 0
    while (i++ < count) {
      const value = valueOf(generate(schemaName)[0])
      promises.push(
        // @ts-ignore
        project[schemaName].create(value)
      )
    }
  }
  return Promise.all(promises)
}

/**
 * If the path is a regular file, return its size in bytes.
 *
 * If the path is a directory, return the size of all regular files inside.
 * Recurses through subdirectories.
 *
 * If the path is anything else, such as a symlink, `0` is returned.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
export async function getDiskUsage(filePath) {
  const stats = await fsPromises.stat(filePath)

  if (stats.isFile()) return stats.size

  if (!stats.isDirectory()) return 0

  const dirents = await fsPromises.readdir(filePath, {
    withFileTypes: true,
    recursive: true,
  })
  let result = 0
  await Promise.all(
    dirents.map(async (dirent) => {
      if (!dirent.isFile()) return 0
      const dirFilePath = path.join(dirent.path, dirent.name)
      const dirStats = await fsPromises.stat(dirFilePath)
      result += dirStats.size
    })
  )
  return result
}

/**
 * @template {object} T
 * @param {T[]} arr
 * @param {keyof T} key
 */
export function sortBy(arr, key) {
  return arr.sort(function (a, b) {
    if (a[key] < b[key]) return -1
    if (a[key] > b[key]) return 1
    return 0
  })
}

/** @param {String} path */
export async function getExpectedConfig(path) {
  const config = await readConfig(path)
  return {
    presets: arrayFrom(config.presets()),
    fields: arrayFrom(config.fields()),
    icons: await arrayFrom(config.icons()),
  }
}

/** @param {import('@comapeo/schema').MapeoDoc[]} docs */
export function sortById(docs) {
  return sortBy(docs, 'docId')
}

/**
 * @template T
 * @param {Readonly<Set<T>>} set
 * @param {ReadonlyArray<T>} toAdd
 * @returns {Set<T>}
 */
export function setAdd(set, ...toAdd) {
  const result = new Set(set)
  for (const value of toAdd) result.add(value)
  return result
}

/**
 * Lazy way of removing fields with undefined values from an object
 * @param {unknown} object
 */
export function removeUndefinedFields(object) {
  return JSON.parse(JSON.stringify(object))
}

export function randomDate() {
  return new Date(randomNum({ min: 0, max: Date.now() }))
}

export function randomBool() {
  return Math.random() >= 0.5
}

/**
 * @param {{ min?: number, max?: number, precision?: number }} [options]
 */
export function randomNum({ min = 0, max = 1, precision } = {}) {
  const num = Math.random() * (max - min) + min
  if (typeof precision === 'undefined') return num
  return round(num, precision)
}

/**
 * @template T
 * @param {Readonly<ArrayLike<T>>} arr
 * @returns {undefined | T}
 */
export function sample(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}
