import { randomBytes } from 'crypto'
import path from 'path'
import { KeyManager } from '@mapeo/crypto'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Hypercore from 'hypercore'
import { TypedEmitter } from 'tiny-typed-emitter'
import pTimeout from 'p-timeout'
import { createRequire } from 'module'

import { IndexWriter } from './index-writer/index.js'
import {
  MapeoProject,
  kBlobStore,
  kClearDataIfLeft,
  kProjectLeave,
  kSetOwnDeviceInfo,
} from './mapeo-project.js'
import {
  localDeviceInfoTable,
  projectKeysTable,
  projectSettingsTable,
} from './schema/client.js'
import { ProjectKeys } from './generated/keys.js'
import {
  deNullify,
  getDeviceId,
  keyToId,
  projectIdToNonce,
  projectKeyToId,
  projectKeyToProjectInviteId,
  projectKeyToPublicId,
} from './utils.js'
import { openedNoiseSecretStream } from './lib/noise-secret-stream-helpers.js'
import { RandomAccessFilePool } from './core-manager/random-access-file-pool.js'
import BlobServerPlugin from './fastify-plugins/blobs.js'
import IconServerPlugin from './fastify-plugins/icons.js'
import { plugin as MapServerPlugin } from './fastify-plugins/maps.js'
import { getFastifyServerAddress } from './fastify-plugins/utils.js'
import { LocalPeers } from './local-peers.js'
import { InviteApi } from './invite-api.js'
import { LocalDiscovery } from './discovery/local-discovery.js'
import { Roles } from './roles.js'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { Logger } from './logger.js'
import {
  kSyncState,
  kRequestFullStop,
  kRescindFullStopRequest,
} from './sync/sync-api.js'
/** @import { ProjectSettingsValue as ProjectValue } from '@comapeo/schema' */
/** @import { SetNonNullable } from 'type-fest' */
/** @import { CoreStorage, Namespace } from './types.js' */
/** @import { DeviceInfoParam } from './schema/client.js' */

/** @typedef {SetNonNullable<ProjectKeys, 'encryptionKeys'>} ValidatedProjectKeys */

const CLIENT_SQLITE_FILE_NAME = 'client.db'

// Max file descriptors that RandomAccessFile should use for hypercore storage
// and index bitfield persistence (used by MultiCoreIndexer). Android has a
// limit of 1024 per process, so choosing 768 to leave 256 descriptors free for
// other things e.g. SQLite and other parts of the app.
const MAX_FILE_DESCRIPTORS = 768

// Prefix names for routes registered with http server
const BLOBS_PREFIX = 'blobs'
const ICONS_PREFIX = 'icons'
const MAPS_PREFIX = 'maps'

const require = createRequire(import.meta.url)
export const DEFAULT_FALLBACK_MAP_FILE_PATH = require.resolve(
  '@comapeo/fallback-smp'
)

export const DEFAULT_ONLINE_STYLE_URL =
  'https://demotiles.maplibre.org/style.json'

export const kRPC = Symbol('rpc')
export const kManagerReplicate = Symbol('replicate manager')

/**
 * @typedef {Omit<import('./local-peers.js').PeerInfo, 'protomux'>} PublicPeerInfo
 */

/**
 * @typedef {object} MapeoManagerEvents
 * @property {(peers: PublicPeerInfo[]) => void} local-peers Emitted when the list of connected peers changes (new ones added, or connection status changes)
 */

/**
 * @extends {TypedEmitter<MapeoManagerEvents>}
 */
export class MapeoManager extends TypedEmitter {
  #keyManager
  #projectSettingsIndexWriter
  #db
  // Maps project public id -> project instance
  /** @type {Map<string, MapeoProject>} */
  #activeProjects
  /** @type {CoreStorage} */
  #coreStorage
  #dbFolder
  /** @type {string} */
  #projectMigrationsFolder
  #deviceId
  #localPeers
  #invite
  #fastify
  #localDiscovery
  #loggerBase
  #l
  #defaultConfigPath

  /**
   * @param {Object} opts
   * @param {Buffer} opts.rootKey 16-bytes of random data that uniquely identify the device, used to derive a 32-byte master key, which is used to derive all the keypairs used for Mapeo
   * @param {string} opts.dbFolder Folder for sqlite Dbs. Folder must exist. Use ':memory:' to store everything in-memory
   * @param {string} opts.projectMigrationsFolder path for drizzle migrations folder for project database
   * @param {string} opts.clientMigrationsFolder path for drizzle migrations folder for client database
   * @param {string | CoreStorage} opts.coreStorage Folder for hypercore storage or a function that returns a RandomAccessStorage instance
   * @param {import('fastify').FastifyInstance} opts.fastify Fastify server instance
   * @param {String} [opts.defaultConfigPath]
   * @param {string} [opts.customMapPath] File path to a locally stored Styled Map Package (SMP).
   * @param {string} [opts.fallbackMapPath] File path to a locally stored Styled Map Package (SMP)
   * @param {string} [opts.defaultOnlineStyleUrl] URL for an online-hosted StyleJSON asset.
   */
  constructor({
    rootKey,
    dbFolder,
    projectMigrationsFolder,
    clientMigrationsFolder,
    coreStorage,
    fastify,
    defaultConfigPath,
    customMapPath,
    fallbackMapPath = DEFAULT_FALLBACK_MAP_FILE_PATH,
    defaultOnlineStyleUrl = DEFAULT_ONLINE_STYLE_URL,
  }) {
    super()
    this.#keyManager = new KeyManager(rootKey)
    this.#deviceId = getDeviceId(this.#keyManager)
    this.#defaultConfigPath = defaultConfigPath
    const logger = (this.#loggerBase = new Logger({ deviceId: this.#deviceId }))
    this.#l = Logger.create('manager', logger)
    this.#dbFolder = dbFolder
    this.#projectMigrationsFolder = projectMigrationsFolder
    const sqlite = new Database(
      dbFolder === ':memory:'
        ? ':memory:'
        : path.join(dbFolder, CLIENT_SQLITE_FILE_NAME)
    )
    this.#db = drizzle(sqlite)
    migrate(this.#db, { migrationsFolder: clientMigrationsFolder })

    this.#localPeers = new LocalPeers({ logger })
    this.#localPeers.on('peers', (peers) => {
      this.emit('local-peers', omitPeerProtomux(peers))
    })
    this.#localPeers.on('discovery-key', (dk) => {
      if (this.#activeProjects.size === 0) {
        this.#l.log('Received dk %h but no active projects', dk)
      }
    })

    this.#projectSettingsIndexWriter = new IndexWriter({
      tables: [projectSettingsTable],
      sqlite,
      logger,
    })
    this.#activeProjects = new Map()

    this.#invite = new InviteApi({
      rpc: this.#localPeers,
      queries: {
        getProjectByInviteId: (projectInviteId) =>
          this.#db
            .select()
            .from(projectKeysTable)
            .where(eq(projectKeysTable.projectInviteId, projectInviteId))
            .get(),
        addProject: this.addProject,
      },
      logger,
    })

    if (typeof coreStorage === 'string') {
      const pool = new RandomAccessFilePool(MAX_FILE_DESCRIPTORS)
      // @ts-expect-error
      this.#coreStorage = Hypercore.defaultStorage(coreStorage, { pool })
    } else {
      this.#coreStorage = coreStorage
    }

    this.#fastify = fastify
    this.#fastify.register(BlobServerPlugin, {
      prefix: BLOBS_PREFIX,
      getBlobStore: async (projectPublicId) => {
        const project = await this.getProject(projectPublicId)
        return project[kBlobStore]
      },
    })
    this.#fastify.register(IconServerPlugin, {
      prefix: ICONS_PREFIX,
      getProject: this.getProject.bind(this),
    })
    this.#fastify.register(MapServerPlugin, {
      prefix: MAPS_PREFIX,
      customMapPath,
      defaultOnlineStyleUrl,
      fallbackMapPath,
    })

    this.#localDiscovery = new LocalDiscovery({
      identityKeypair: this.#keyManager.getIdentityKeypair(),
      logger,
    })
    this.#localDiscovery.on('connection', this.#replicate.bind(this))
  }

  /**
   * MapeoRPC instance, used for tests
   */
  get [kRPC]() {
    return this.#localPeers
  }

  get deviceId() {
    return this.#deviceId
  }

  /**
   * Create a Mapeo replication stream. This replication connects the Mapeo RPC
   * channel and allows invites. All active projects will sync automatically to
   * this replication stream. Only use for local (trusted) connections, because
   * the RPC channel key is public. To sync a specific project without
   * connecting RPC, use project[kProjectReplication].
   *
   * @param {boolean} isInitiator
   */
  [kManagerReplicate](isInitiator) {
    const noiseStream = new NoiseSecretStream(isInitiator, undefined, {
      keyPair: this.#keyManager.getIdentityKeypair(),
    })
    return this.#replicate(noiseStream)
  }

  /**
   * @param {'blobs' | 'icons' | 'maps'} mediaType
   * @returns {Promise<string>}
   */
  async #getMediaBaseUrl(mediaType) {
    /** @type {string | null} */
    let prefix = null

    switch (mediaType) {
      case 'blobs': {
        prefix = BLOBS_PREFIX
        break
      }
      case 'icons': {
        prefix = ICONS_PREFIX
        break
      }
      case 'maps': {
        prefix = MAPS_PREFIX
        break
      }
      default: {
        throw new Error(`Unsupported media type ${mediaType}`)
      }
    }

    const base = await getFastifyServerAddress(this.#fastify.server, {
      timeout: 5000,
    })

    return base + '/' + prefix
  }

  /**
   * @param {NoiseSecretStream<any>} noiseStream
   */
  #replicate(noiseStream) {
    const replicationStream = this.#localPeers.connect(noiseStream)

    openedNoiseSecretStream(noiseStream)
      .then((openedNoiseStream) => {
        if (openedNoiseStream.destroyed) return

        const deviceInfo = this.getDeviceInfo()
        if (!hasSavedDeviceInfo(deviceInfo)) return

        const peerId = keyToId(openedNoiseStream.remotePublicKey)

        return this.#localPeers.sendDeviceInfo(peerId, deviceInfo)
      })
      .catch((e) => {
        // Ignore error but log
        this.#l.log(
          'Failed to send device info to peer %h',
          noiseStream.remotePublicKey,
          e
        )
      })

    return replicationStream
  }

  /**
   * @param {Buffer} keysCipher
   * @param {string} projectId
   * @returns {ProjectKeys}
   */
  #decodeProjectKeysCipher(keysCipher, projectId) {
    const nonce = projectIdToNonce(projectId)
    return ProjectKeys.decode(
      this.#keyManager.decryptLocalMessage(keysCipher, nonce)
    )
  }

  /**
   * @param {string} projectId
   * @returns {Pick<ConstructorParameters<typeof MapeoProject>[0], 'dbPath' | 'coreStorage'>}
   */
  #projectStorage(projectId) {
    return {
      dbPath:
        this.#dbFolder === ':memory:'
          ? ':memory:'
          : path.join(this.#dbFolder, projectId + '.db'),
      coreStorage: (name) => this.#coreStorage(path.join(projectId, name)),
    }
  }

  /**
   * @param {Object} opts
   * @param {string} opts.projectId
   * @param {string} opts.projectPublicId
   * @param {Readonly<Buffer>} opts.projectInviteId
   * @param {ProjectKeys} opts.projectKeys
   * @param {Readonly<{ name?: string }>} [opts.projectInfo]
   */
  #saveToProjectKeysTable({
    projectId,
    projectPublicId,
    projectInviteId,
    projectKeys,
    projectInfo,
  }) {
    const encoded = ProjectKeys.encode(projectKeys).finish()
    const nonce = projectIdToNonce(projectId)

    const keysCipher = this.#keyManager.encryptLocalMessage(
      Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      nonce
    )

    this.#db
      .insert(projectKeysTable)
      .values({
        projectId,
        projectPublicId,
        projectInviteId,
        keysCipher,
        projectInfo,
      })
      .onConflictDoUpdate({
        target: projectKeysTable.projectId,
        set: { projectPublicId, projectInviteId, keysCipher, projectInfo },
      })
      .run()
  }

  /**
   * Create a new project.
   * @param {(
   *   import('type-fest').Simplify<(
   *     Partial<Pick<ProjectValue, 'name'>> &
   *     { configPath?: string }
   *   )>
   * )} [options]
   * @returns {Promise<string>} Project public id
   */
  async createProject({ name, configPath = this.#defaultConfigPath } = {}) {
    // 1. Create project keypair
    const projectKeypair = KeyManager.generateProjectKeypair()

    // 2. Create namespace encryption keys
    /** @type {Record<Namespace, Buffer>} */
    const encryptionKeys = {
      auth: randomBytes(32),
      blob: randomBytes(32),
      blobIndex: randomBytes(32),
      config: randomBytes(32),
      data: randomBytes(32),
    }

    // 3. Save keys to client db  projectKeys table
    /** @type {ProjectKeys} */
    const keys = {
      projectKey: projectKeypair.publicKey,
      projectSecretKey: projectKeypair.secretKey,
      encryptionKeys,
    }

    const projectId = projectKeyToId(keys.projectKey)
    const projectPublicId = projectKeyToPublicId(keys.projectKey)
    const projectInviteId = projectKeyToProjectInviteId(keys.projectKey)

    this.#saveToProjectKeysTable({
      projectId,
      projectPublicId,
      projectInviteId,
      projectKeys: keys,
    })

    // 4. Create MapeoProject instance
    const project = await this.#createProjectInstance({
      encryptionKeys,
      projectKey: projectKeypair.publicKey,
      projectSecretKey: projectKeypair.secretKey,
    })

    project.once('close', () => {
      this.#activeProjects.delete(projectPublicId)
    })

    // 5. Write project settings to project instance
    await project.$setProjectSettings({ name })

    // 6. Write device info into project
    const deviceInfo = this.getDeviceInfo()
    if (hasSavedDeviceInfo(deviceInfo)) {
      await project[kSetOwnDeviceInfo](deviceInfo)
    }

    // TODO: Close the project instance instead of keeping it around
    this.#activeProjects.set(projectPublicId, project)

    // 7. Load config, if relevant
    // TODO: see how to expose warnings to frontend
    /* eslint-disable no-unused-vars */
    let warnings
    if (configPath) {
      warnings = await project.importConfig({ configPath })
    }

    this.#l.log(
      'created project %h, public id: %S',
      projectKeypair.publicKey,
      projectPublicId
    )

    // 7. Return project public id
    return projectPublicId
  }

  /**
   * @param {string} projectPublicId
   * @returns {Promise<MapeoProject>}
   */
  async getProject(projectPublicId) {
    // 1. Check for existing active project
    const activeProject = this.#activeProjects.get(projectPublicId)

    if (activeProject) return activeProject

    // 2. Create project instance
    const projectKeysTableResult = this.#db
      .select({
        projectId: projectKeysTable.projectId,
        keysCipher: projectKeysTable.keysCipher,
      })
      .from(projectKeysTable)
      .where(eq(projectKeysTable.projectPublicId, projectPublicId))
      .get()

    if (!projectKeysTableResult) {
      throw new Error(`NotFound: project ID ${projectPublicId} not found`)
    }

    const { projectId } = projectKeysTableResult

    const projectKeys = this.#decodeProjectKeysCipher(
      projectKeysTableResult.keysCipher,
      projectId
    )

    const project = await this.#createProjectInstance(projectKeys)

    project.once('close', () => {
      this.#activeProjects.delete(projectPublicId)
    })

    // 3. Keep track of project instance as we know it's a properly existing project
    this.#activeProjects.set(projectPublicId, project)

    return project
  }

  /** @param {ProjectKeys} projectKeys */
  async #createProjectInstance(projectKeys) {
    validateProjectKeys(projectKeys)
    const projectId = keyToId(projectKeys.projectKey)
    const project = new MapeoProject({
      ...this.#projectStorage(projectId),
      ...projectKeys,
      projectMigrationsFolder: this.#projectMigrationsFolder,
      keyManager: this.#keyManager,
      sharedDb: this.#db,
      sharedIndexWriter: this.#projectSettingsIndexWriter,
      localPeers: this.#localPeers,
      logger: this.#loggerBase,
      getMediaBaseUrl: this.#getMediaBaseUrl.bind(this),
    })
    await project[kClearDataIfLeft]()
    return project
  }

  /**
   * @returns {Promise<Array<Pick<ProjectValue, 'name'> & { projectId: string, createdAt?: string, updatedAt?: string}>>}
   */
  async listProjects() {
    // We use the project keys table as the source of truth for projects that exist
    // because we will always update this table when doing a create or add
    // whereas the project table will only have projects that have been created, or added + synced
    const allProjectKeysResult = this.#db
      .select({
        projectId: projectKeysTable.projectId,
        projectPublicId: projectKeysTable.projectPublicId,
        projectInfo: projectKeysTable.projectInfo,
      })
      .from(projectKeysTable)
      .all()

    const allProjectsResult = this.#db
      .select({
        projectId: projectSettingsTable.docId,
        createdAt: projectSettingsTable.createdAt,
        updatedAt: projectSettingsTable.updatedAt,
        name: projectSettingsTable.name,
      })
      .from(projectSettingsTable)
      .all()

    /** @type {Array<Pick<ProjectValue, 'name'> & { projectId: string, createdAt?: string, updatedAt?: string, createdBy?: string }>} */
    const result = []

    for (const {
      projectId,
      projectPublicId,
      projectInfo,
    } of allProjectKeysResult) {
      const existingProject = allProjectsResult.find(
        (p) => p.projectId === projectId
      )

      result.push(
        deNullify({
          projectId: projectPublicId,
          createdAt: existingProject?.createdAt,
          updatedAt: existingProject?.updatedAt,
          name: existingProject?.name || projectInfo.name,
        })
      )
    }

    return result
  }

  /**
   * Add a project to this device. After adding a project the client should
   * await `project.$waitForInitialSync()` to ensure that the device has
   * downloaded their proof of project membership and the project config.
   *
   * @param {Pick<import('./generated/rpc.js').ProjectJoinDetails, 'projectKey' | 'encryptionKeys'> & { projectName: string }} projectJoinDetails
   * @param {{ waitForSync?: boolean }} [opts] Set opts.waitForSync = false to not wait for sync during addProject()
   * @returns {Promise<string>}
   */
  addProject = async (
    { projectKey, encryptionKeys, projectName },
    { waitForSync = true } = {}
  ) => {
    const projectPublicId = projectKeyToPublicId(projectKey)

    // 1. Check for an active project
    const activeProject = this.#activeProjects.get(projectPublicId)

    if (activeProject) {
      throw new Error(`Project with ID ${projectPublicId} already exists`)
    }

    // 2. Check if the project exists in the project keys table
    // If it does, that means the project has already been either created or added before
    const projectId = projectKeyToId(projectKey)
    const projectInviteId = projectKeyToProjectInviteId(projectKey)

    const projectExists = this.#db
      .select()
      .from(projectKeysTable)
      .where(eq(projectKeysTable.projectId, projectId))
      .get()

    if (projectExists) {
      throw new Error(`Project with ID ${projectPublicId} already exists`)
    }

    // No awaits here - need to update table in same tick as the projectExists check

    // 3. Update the project keys table
    this.#saveToProjectKeysTable({
      projectId,
      projectPublicId,
      projectInviteId,
      projectKeys: {
        projectKey,
        encryptionKeys,
      },
      projectInfo: { name: projectName },
    })

    // Any errors from here we need to remove project from db because it has not
    // been fully added and synced
    try {
      // 4. Write device info into project
      const project = await this.getProject(projectPublicId)

      try {
        const deviceInfo = this.getDeviceInfo()
        if (hasSavedDeviceInfo(deviceInfo)) {
          await project[kSetOwnDeviceInfo](deviceInfo)
        }
      } catch (e) {
        // Can ignore an error trying to write device info
        this.#l.log(
          'ERROR: failed to write project %h deviceInfo %o',
          projectKey,
          e
        )
      }

      // 5. Wait for initial project sync
      if (waitForSync) {
        await this.#waitForInitialSync(project)
      }

      this.#activeProjects.set(projectPublicId, project)
    } catch (e) {
      this.#l.log('ERROR: could not add project', e)
      this.#db
        .delete(projectKeysTable)
        .where(eq(projectKeysTable.projectId, projectId))
        .run()
      throw e
    }
    this.#l.log('Added project %h, public ID: %S', projectKey, projectPublicId)
    return projectPublicId
  }

  /**
   * Sync initial data: the `auth` cores which contain the role messages,
   * and the `config` cores which contain the project name & custom config (if
   * it exists). The API consumer should await this after `client.addProject()`
   * to ensure that the device is fully added to the project.
   *
   * @param {MapeoProject} project
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=5000] Timeout in milliseconds for max time
   * to wait between sync status updates before giving up. As long as syncing is
   * happening, this will never timeout, but if more than timeoutMs passes
   * without any sync activity, then this will resolve `false` e.g. data has not
   * synced
   * @returns {Promise<boolean>}
   */
  async #waitForInitialSync(project, { timeoutMs = 5000 } = {}) {
    const [ownRole, projectSettings] = await Promise.all([
      project.$getOwnRole(),
      project.$getProjectSettings(),
    ])
    const {
      auth: { localState: authState },
      config: { localState: configState },
    } = project.$sync[kSyncState].getState()
    const isRoleSynced = ownRole !== Roles.NO_ROLE
    const isProjectSettingsSynced =
      projectSettings !== MapeoProject.EMPTY_PROJECT_SETTINGS
    // Assumes every project that someone is invited to has at least one record
    // in the auth store - the row record for the invited device
    const isAuthSynced = authState.want === 0 && authState.have > 0
    // Assumes every project that someone is invited to has at least one record
    // in the config store - defining the name of the project.
    // TODO: Enforce adding a project name in the invite method
    const isConfigSynced = configState.want === 0 && configState.have > 0
    if (
      isRoleSynced &&
      isProjectSettingsSynced &&
      isAuthSynced &&
      isConfigSynced
    ) {
      return true
    } else {
      this.#l.log(
        'Pending initial sync: role %s, projectSettings %o, auth %o, config %o',
        isRoleSynced,
        isProjectSettingsSynced,
        isAuthSynced,
        isConfigSynced
      )
    }
    return new Promise((resolve, reject) => {
      /** @param {import('./sync/sync-state.js').State} syncState */
      const onSyncState = (syncState) => {
        clearTimeout(timeoutId)
        if (syncState.auth.dataToSync || syncState.config.dataToSync) {
          timeoutId = setTimeout(onTimeout, timeoutMs)
          return
        }
        project.$sync[kSyncState].off('state', onSyncState)
        resolve(this.#waitForInitialSync(project, { timeoutMs }))
      }
      const onTimeout = () => {
        project.$sync[kSyncState].off('state', onSyncState)
        reject(new Error('Sync timeout'))
      }
      let timeoutId = setTimeout(onTimeout, timeoutMs)
      project.$sync[kSyncState].on('state', onSyncState)
    })
  }

  /**
   * @typedef {import('./schema/client.js').DeviceInfoParam['deviceType']} RPCDeviceType
   */

  /**
   * @template {import('type-fest').Exact<
   * import('./schema/client.js').DeviceInfoParam & {deviceType?: RPCDeviceType}, T>} T
   * @param {T} deviceInfo
   */
  async setDeviceInfo(deviceInfo) {
    const values = { deviceId: this.#deviceId, deviceInfo }
    this.#db
      .insert(localDeviceInfoTable)
      .values(values)
      .onConflictDoUpdate({
        target: localDeviceInfoTable.deviceId,
        set: values,
      })
      .run()

    const listedProjects = await this.listProjects()
    await Promise.all(
      listedProjects.map(async ({ projectId }) => {
        const project = await this.getProject(projectId)
        await project[kSetOwnDeviceInfo](deviceInfo)
      })
    )

    if (deviceInfo.deviceType !== 'selfHostedServer') {
      await Promise.all(
        this.#localPeers.peers
          .filter(({ status }) => status === 'connected')
          .map((peer) =>
            this.#localPeers.sendDeviceInfo(
              peer.deviceId,
              // TODO TypeScript isn't smart enough to know that deviceInfo is okay here?
              /** @type {any} */ (deviceInfo)
            )
          )
      )
    }

    this.#l.log('set device info %o', deviceInfo)
  }

  /**
   * @returns {(
   *   {
   *     deviceId: string;
   *     deviceType: DeviceInfoParam['deviceType']
   *   } & Partial<DeviceInfoParam>
   * )}
   */
  getDeviceInfo() {
    const row = this.#db
      .select()
      .from(localDeviceInfoTable)
      .where(eq(localDeviceInfoTable.deviceId, this.#deviceId))
      .get()
    return {
      deviceId: this.#deviceId,
      deviceType: 'device_type_unspecified',
      ...row?.deviceInfo,
    }
  }

  /**
   * @returns {InviteApi}
   */
  get invite() {
    return this.#invite
  }

  /** @returns {Promise<{ name: string, port: number }>} */
  startLocalPeerDiscoveryServer() {
    return this.#localDiscovery.start()
  }

  /** @type {LocalDiscovery['stop']} */
  stopLocalPeerDiscoveryServer(opts) {
    return this.#localDiscovery.stop(opts)
  }

  /** @type {LocalDiscovery['connectPeer']} */
  connectLocalPeer(peer) {
    this.#localDiscovery.connectPeer(peer)
  }

  /**
   * @returns {Promise<PublicPeerInfo[]>}
   */
  async listLocalPeers() {
    return omitPeerProtomux(this.#localPeers.peers)
  }

  /**
   * Call this when the app goes into the background.
   *
   * Will gracefully shut down sync.
   *
   * @see {@link onForegrounded}
   * @returns {void}
   */
  onBackgrounded() {
    const projects = this.#activeProjects.values()
    for (const project of projects) project.$sync[kRequestFullStop]()
  }

  /**
   * Call this when the app goes into the foreground.
   *
   * Will undo the effects of `onBackgrounded`.
   *
   * @see {@link onBackgrounded}
   * @returns {void}
   */
  onForegrounded() {
    const projects = this.#activeProjects.values()
    for (const project of projects) project.$sync[kRescindFullStopRequest]()
  }

  /**
   * @param {string} projectPublicId
   */
  async leaveProject(projectPublicId) {
    const project = await this.getProject(projectPublicId)

    await project[kProjectLeave]()

    const row = this.#db
      .select({
        keysCipher: projectKeysTable.keysCipher,
        projectId: projectKeysTable.projectId,
        projectInfo: projectKeysTable.projectInfo,
      })
      .from(projectKeysTable)
      .where(eq(projectKeysTable.projectPublicId, projectPublicId))
      .get()

    if (!row) {
      throw new Error(`NotFound: project ID ${projectPublicId} not found`)
    }

    const { keysCipher, projectId, projectInfo } = row

    const projectKeys = this.#decodeProjectKeysCipher(keysCipher, projectId)
    const projectInviteId = projectKeyToProjectInviteId(projectKeys.projectKey)

    const updatedEncryptionKeys = projectKeys.encryptionKeys
      ? // Delete all encryption keys except for auth
        { auth: projectKeys.encryptionKeys.auth }
      : undefined

    this.#saveToProjectKeysTable({
      projectId,
      projectPublicId,
      projectInviteId,
      projectInfo,
      projectKeys: {
        ...projectKeys,
        encryptionKeys: updatedEncryptionKeys,
      },
    })

    this.#db
      .delete(projectSettingsTable)
      .where(eq(projectSettingsTable.docId, projectId))
      .run()

    this.#activeProjects.delete(projectPublicId)
  }

  async getMapStyleJsonUrl() {
    await pTimeout(this.#fastify.ready(), { milliseconds: 1000 })
    return (await this.#getMediaBaseUrl('maps')) + '/style.json'
  }
}

// We use the `protomux` property of connected peers internally, but we don't
// expose it to the API. I have avoided using a private symbol for this for fear
// that we could accidentally keep references around of protomux instances,
// which could cause a memory leak (it shouldn't, but just to eliminate the
// possibility)

/**
 * Remove the protomux property of connected peers
 *
 * @param {import('./local-peers.js').PeerInfo[]} peers
 * @returns {PublicPeerInfo[]}
 */
function omitPeerProtomux(peers) {
  return peers.map(
    ({
      // @ts-ignore
      // eslint-disable-next-line no-unused-vars
      protomux,
      ...publicPeerInfo
    }) => {
      return publicPeerInfo
    }
  )
}

/**
 * @param {ProjectKeys} projectKeys
 * @returns {asserts projectKeys is ValidatedProjectKeys}
 */
function validateProjectKeys(projectKeys) {
  if (!projectKeys.encryptionKeys) {
    throw new Error('encryptionKeys should not be undefined')
  }
}

/**
 * @param {Awaited<ReturnType<typeof MapeoManager.prototype.getDeviceInfo>>} partialDeviceInfo
 * @returns {partialDeviceInfo is import('./generated/rpc.js').DeviceInfo}
 */
function hasSavedDeviceInfo(partialDeviceInfo) {
  return Boolean(partialDeviceInfo.name)
}
