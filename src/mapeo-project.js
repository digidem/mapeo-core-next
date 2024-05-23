import path from 'path'
import * as fs from 'node:fs'
import Database from 'better-sqlite3'
import { decodeBlockPrefix, decode } from '@mapeo/schema'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { discoveryKey } from 'hypercore-crypto'
import { TypedEmitter } from 'tiny-typed-emitter'

import {
  NAMESPACES,
  NAMESPACE_SCHEMAS,
  DRIZZLE_MIGRATIONS_TABLE,
} from './constants.js'
import { CoreManager } from './core-manager/index.js'
import { DataStore } from './datastore/index.js'
import { DataType, kCreateWithDocId } from './datatype/index.js'
import { BlobStore } from './blob-store/index.js'
import { BlobApi } from './blob-api.js'
import { IndexWriter } from './index-writer/index.js'
import drizzleMigrate from './lib/drizzle-migrate.js'
import { projectSettingsTable } from './schema/client.js'
import {
  coreOwnershipTable,
  deviceInfoTable,
  fieldTable,
  observationTable,
  trackTable,
  presetTable,
  roleTable,
  iconTable,
  translationTable,
} from './schema/project.js'
import {
  CoreOwnership,
  getWinner,
  mapAndValidateCoreOwnership,
} from './core-ownership.js'
import {
  BLOCKED_ROLE_ID,
  COORDINATOR_ROLE_ID,
  Roles,
  LEFT_ROLE_ID,
} from './roles.js'
import {
  ExhaustivenessError,
  assert,
  getDeviceId,
  projectKeyToId,
  projectKeyToPublicId,
  valueOf,
} from './utils.js'
import { MemberApi } from './member-api.js'
import { SyncApi, kHandleDiscoveryKey } from './sync/sync-api.js'
import { Logger } from './logger.js'
import { IconApi } from './icon-api.js'
import { readConfig } from './config-import.js'
import TranslationApi from './translation-api.js'

/** @typedef {Omit<import('@mapeo/schema').ProjectSettingsValue, 'schemaName'>} EditableProjectSettings */

const CORESTORE_STORAGE_FOLDER_NAME = 'corestore'
const INDEXER_STORAGE_FOLDER_NAME = 'indexer'
export const kCoreManager = Symbol('coreManager')
export const kCoreOwnership = Symbol('coreOwnership')
export const kSetOwnDeviceInfo = Symbol('kSetOwnDeviceInfo')
export const kBlobStore = Symbol('blobStore')
export const kProjectReplicate = Symbol('replicate project')
export const kDataTypes = Symbol('dataTypes')
export const kProjectLeave = Symbol('leave project')

const EMPTY_PROJECT_SETTINGS = Object.freeze({})

/**
 * @extends {TypedEmitter<{ close: () => void }>}
 */
export class MapeoProject extends TypedEmitter {
  #projectId
  #deviceId
  #coreManager
  #indexWriter
  #dataStores
  #dataTypes
  #blobStore
  #coreOwnership
  #roles
  /** @ts-ignore */
  #ownershipWriteDone
  #sqlite
  #memberApi
  #iconApi
  #syncApi
  /** @type {TranslationApi} */
  #translationApi
  #l

  static EMPTY_PROJECT_SETTINGS = EMPTY_PROJECT_SETTINGS

  /**
   * @param {Object} opts
   * @param {string} opts.dbPath Path to store project sqlite db. Use `:memory:` for memory storage
   * @param {string} opts.projectMigrationsFolder path for drizzle migration folder for project
   * @param {import('@mapeo/crypto').KeyManager} opts.keyManager mapeo/crypto KeyManager instance
   * @param {Buffer} opts.projectKey 32-byte public key of the project creator core
   * @param {Buffer} [opts.projectSecretKey] 32-byte secret key of the project creator core
   * @param {import('./generated/keys.js').EncryptionKeys} opts.encryptionKeys Encryption keys for each namespace
   * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} opts.sharedDb
   * @param {IndexWriter} opts.sharedIndexWriter
   * @param {import('./types.js').CoreStorage} opts.coreStorage Folder to store all hypercore data
   * @param {(mediaType: 'blobs' | 'icons') => Promise<string>} opts.getMediaBaseUrl
   * @param {import('./local-peers.js').LocalPeers} opts.localPeers
   * @param {Logger} [opts.logger]
   *
   */
  constructor({
    dbPath,
    projectMigrationsFolder,
    sharedDb,
    sharedIndexWriter,
    coreStorage,
    keyManager,
    projectKey,
    projectSecretKey,
    encryptionKeys,
    getMediaBaseUrl,
    localPeers,
    logger,
  }) {
    super()

    this.#l = Logger.create('project', logger)
    this.#deviceId = getDeviceId(keyManager)
    this.#projectId = projectKeyToId(projectKey)

    ///////// 1. Setup database

    this.#sqlite = new Database(dbPath)
    const db = drizzle(this.#sqlite)
    const migrationResult = drizzleMigrate(db, {
      migrationsFolder: projectMigrationsFolder,
      migrationsTable: DRIZZLE_MIGRATIONS_TABLE,
    })

    const indexedTables = [
      observationTable,
      trackTable,
      presetTable,
      fieldTable,
      coreOwnershipTable,
      roleTable,
      deviceInfoTable,
      iconTable,
      translationTable,
    ]

    ///////// 2. Wipe data if we need to re-index

    switch (migrationResult) {
      case 'no migration':
      case 'migrated from scratch':
        break
      case 'migrated something':
        fs.rmSync(INDEXER_STORAGE_FOLDER_NAME, {
          force: true,
          recursive: true,
          maxRetries: 10,
        })
        for (const table of indexedTables) db.delete(table).run()
        break
      default:
        throw new ExhaustivenessError(migrationResult)
    }

    ///////// 3. Setup random-access-storage functions

    /** @type {ConstructorParameters<typeof CoreManager>[0]['storage']} */
    const coreManagerStorage = (name) =>
      coreStorage(path.join(CORESTORE_STORAGE_FOLDER_NAME, name))

    /** @type {ConstructorParameters<typeof DataStore>[0]['storage']} */
    const indexerStorage = (name) =>
      coreStorage(path.join(INDEXER_STORAGE_FOLDER_NAME, name))

    ///////// 4. Create instances

    this.#coreManager = new CoreManager({
      projectSecretKey,
      encryptionKeys,
      projectKey,
      keyManager,
      storage: coreManagerStorage,
      db,
      logger: this.#l,
    })

    this.#indexWriter = new IndexWriter({
      tables: indexedTables,
      sqlite: this.#sqlite,
      getWinner,
      mapDoc: (doc, version) => {
        switch (doc.schemaName) {
          case 'coreOwnership':
            return mapAndValidateCoreOwnership(doc, version)
          case 'deviceInfo':
            return mapAndValidateDeviceInfo(doc, version)
          default:
            return doc
        }
      },
      logger: this.#l,
    })

    this.#dataStores = {
      auth: new DataStore({
        coreManager: this.#coreManager,
        namespace: 'auth',
        batch: (entries) => this.#indexWriter.batch(entries),
        storage: indexerStorage,
      }),
      config: new DataStore({
        coreManager: this.#coreManager,
        namespace: 'config',
        batch: (entries) =>
          this.#handleConfigEntries(entries, {
            projectIndexWriter: this.#indexWriter,
            sharedIndexWriter,
          }),
        storage: indexerStorage,
      }),
      data: new DataStore({
        coreManager: this.#coreManager,
        namespace: 'data',
        batch: (entries) => this.#indexWriter.batch(entries),
        storage: indexerStorage,
      }),
    }

    /** @type {typeof TranslationApi.prototype.get} */
    const getTranslations = (...args) => this.$translation.get(...args)
    this.#dataTypes = {
      observation: new DataType({
        dataStore: this.#dataStores.data,
        table: observationTable,
        db,
        getTranslations,
      }),
      track: new DataType({
        dataStore: this.#dataStores.data,
        table: trackTable,
        db,
        getTranslations,
      }),
      preset: new DataType({
        dataStore: this.#dataStores.config,
        table: presetTable,
        db,
        getTranslations,
      }),
      field: new DataType({
        dataStore: this.#dataStores.config,
        table: fieldTable,
        db,
        getTranslations,
      }),
      projectSettings: new DataType({
        dataStore: this.#dataStores.config,
        table: projectSettingsTable,
        db: sharedDb,
        getTranslations,
      }),
      coreOwnership: new DataType({
        dataStore: this.#dataStores.auth,
        table: coreOwnershipTable,
        db,
        getTranslations,
      }),
      role: new DataType({
        dataStore: this.#dataStores.auth,
        table: roleTable,
        db,
        getTranslations,
      }),
      deviceInfo: new DataType({
        dataStore: this.#dataStores.config,
        table: deviceInfoTable,
        db,
        getTranslations,
      }),
      icon: new DataType({
        dataStore: this.#dataStores.config,
        table: iconTable,
        db,
        getTranslations,
      }),
      translation: new DataType({
        dataStore: this.#dataStores.config,
        table: translationTable,
        db,
        getTranslations: () => {
          throw new Error('Cannot get translation for translations')
        },
      }),
    }
    const identityKeypair = keyManager.getIdentityKeypair()
    const coreKeypairs = getCoreKeypairs({
      projectKey,
      projectSecretKey,
      keyManager,
    })
    this.#coreOwnership = new CoreOwnership({
      dataType: this.#dataTypes.coreOwnership,
      coreKeypairs,
      identityKeypair,
    })
    this.#roles = new Roles({
      dataType: this.#dataTypes.role,
      coreOwnership: this.#coreOwnership,
      coreManager: this.#coreManager,
      projectKey: projectKey,
      deviceKey: keyManager.getIdentityKeypair().publicKey,
    })

    this.#memberApi = new MemberApi({
      deviceId: this.#deviceId,
      roles: this.#roles,
      coreOwnership: this.#coreOwnership,
      encryptionKeys,
      projectKey,
      rpc: localPeers,
      dataTypes: {
        deviceInfo: this.#dataTypes.deviceInfo,
        project: this.#dataTypes.projectSettings,
      },
    })

    const projectPublicId = projectKeyToPublicId(projectKey)

    this.#blobStore = new BlobStore({
      coreManager: this.#coreManager,
    })

    this.$blobs = new BlobApi({
      blobStore: this.#blobStore,
      getMediaBaseUrl: async () => {
        let base = await getMediaBaseUrl('blobs')
        if (!base.endsWith('/')) {
          base += '/'
        }
        return base + projectPublicId
      },
    })

    this.#iconApi = new IconApi({
      iconDataStore: this.#dataStores.config,
      iconDataType: this.#dataTypes.icon,
      getMediaBaseUrl: async () => {
        let base = await getMediaBaseUrl('icons')
        if (!base.endsWith('/')) {
          base += '/'
        }
        return base + projectPublicId
      },
    })

    this.#syncApi = new SyncApi({
      coreManager: this.#coreManager,
      roles: this.#roles,
      logger: this.#l,
    })

    this.#translationApi = new TranslationApi({
      dataType: this.#dataTypes.translation,
      table: translationTable,
    })

    ///////// 5. Replicate local peers automatically

    // Replicate already connected local peers
    for (const peer of localPeers.peers) {
      if (peer.status !== 'connected') continue
      this.#coreManager.creatorCore.replicate(peer.protomux)
    }

    /**
     * @type {import('./local-peers.js').LocalPeersEvents['peer-add']}
     */
    const onPeerAdd = (peer) => {
      this.#coreManager.creatorCore.replicate(peer.protomux)
    }

    /**
     * @type {import('./local-peers.js').LocalPeersEvents['discovery-key']}
     */
    const onDiscoverykey = (discoveryKey, stream) => {
      this.#syncApi[kHandleDiscoveryKey](discoveryKey, stream)
    }

    // When a new peer is found, try to replicate (if it is not a member of the
    // project it will fail the role check and be ignored)
    localPeers.on('peer-add', onPeerAdd)

    // This happens whenever a peer replicates a core to the stream. SyncApi
    // handles replicating this core if we also have it, or requesting the key
    // for the core.
    localPeers.on('discovery-key', onDiscoverykey)

    this.once('close', () => {
      localPeers.off('peer-add', onPeerAdd)
      localPeers.off('discovery-key', onDiscoverykey)
    })

    this.#l.log('Created project instance %h', projectKey)
  }

  /**
   * CoreManager instance, used for tests
   */
  get [kCoreManager]() {
    return this.#coreManager
  }

  /**
   * CoreOwnership instance, used for tests
   */
  get [kCoreOwnership]() {
    return this.#coreOwnership
  }

  /**
   * DataTypes object mappings, used for tests
   */
  get [kDataTypes]() {
    return this.#dataTypes
  }

  get [kBlobStore]() {
    return this.#blobStore
  }

  get deviceId() {
    return this.#deviceId
  }

  /**
   * Resolves when hypercores have all loaded
   */
  async ready() {
    await Promise.all([this.#coreManager.ready(), this.#ownershipWriteDone])
  }

  /**
   */
  async close() {
    this.#l.log('closing project %h', this.#projectId)
    const dataStorePromises = []
    for (const dataStore of Object.values(this.#dataStores)) {
      dataStorePromises.push(dataStore.close())
    }
    await Promise.all(dataStorePromises)
    await this.#coreManager.close()

    this.#sqlite.close()

    this.emit('close')
  }

  /**
   * @param {import('multi-core-indexer').Entry[]} entries
   * @param {{projectIndexWriter: IndexWriter, sharedIndexWriter: IndexWriter}} indexWriters
   */
  async #handleConfigEntries(
    entries,
    { projectIndexWriter, sharedIndexWriter }
  ) {
    /** @type {import('multi-core-indexer').Entry[]} */
    const projectSettingsEntries = []
    /** @type {import('multi-core-indexer').Entry[]} */
    const otherEntries = []

    for (const entry of entries) {
      try {
        const { schemaName } = decodeBlockPrefix(entry.block)

        if (schemaName === 'projectSettings') {
          projectSettingsEntries.push(entry)
        } else if (schemaName === 'translation') {
          const doc = decode(entry.block, {
            coreDiscoveryKey: entry.key,
            index: entry.index,
          })

          assert(doc.schemaName === 'translation', 'expected a translation doc')
          this.#translationApi.index(doc)
          otherEntries.push(entry)
        } else {
          otherEntries.push(entry)
        }
      } catch {
        // Ignore errors thrown by values that can't be decoded for now
      }
    }
    // TODO: Note that docs indexed to the shared index writer (project
    // settings) are not currently returned here, so it is not possible to
    // subscribe to updates for projectSettings
    const [indexed] = await Promise.all([
      projectIndexWriter.batch(otherEntries),
      sharedIndexWriter.batch(projectSettingsEntries),
    ])
    return indexed
  }

  get observation() {
    return this.#dataTypes.observation
  }
  get track() {
    return this.#dataTypes.track
  }
  get preset() {
    return this.#dataTypes.preset
  }
  get field() {
    return this.#dataTypes.field
  }

  get $member() {
    return this.#memberApi
  }

  get $sync() {
    return this.#syncApi
  }

  get $translation() {
    return this.#translationApi
  }

  /**
   * @param {Partial<EditableProjectSettings>} settings
   * @returns {Promise<EditableProjectSettings>}
   */
  async $setProjectSettings(settings) {
    const { projectSettings } = this.#dataTypes

    // We only want to catch the error to the getByDocId call
    // Using try/catch for this is a little verbose when dealing with TS types
    const existing = await projectSettings
      .getByDocId(this.#projectId)
      .catch(() => {
        // project does not exist so return null
        return null
      })

    if (existing) {
      return extractEditableProjectSettings(
        await projectSettings.update([existing.versionId, ...existing.forks], {
          ...valueOf(existing),
          ...settings,
        })
      )
    }

    return extractEditableProjectSettings(
      await projectSettings[kCreateWithDocId](this.#projectId, {
        ...settings,
        schemaName: 'projectSettings',
      })
    )
  }

  /**
   * @returns {Promise<EditableProjectSettings>}
   */
  async $getProjectSettings() {
    try {
      return extractEditableProjectSettings(
        await this.#dataTypes.projectSettings.getByDocId(this.#projectId)
      )
    } catch (e) {
      this.#l.log('No project settings')
      return /** @type {EditableProjectSettings} */ (EMPTY_PROJECT_SETTINGS)
    }
  }

  async $getOwnRole() {
    return this.#roles.getRole(this.#deviceId)
  }

  /**
   * Replicate a project to a @hyperswarm/secret-stream. Invites will not
   * function because the RPC channel is not connected for project replication,
   * and only this project will replicate (to replicate multiple projects you
   * need to replicate the manager instance via manager[kManagerReplicate])
   *
   * @param {Parameters<import('hypercore')['replicate']>[0]} stream A duplex stream, a @hyperswarm/secret-stream, or a Protomux instance
   * @returns
   */
  [kProjectReplicate](stream) {
    // @ts-expect-error - hypercore types need updating
    const replicationStream = this.#coreManager.creatorCore.replicate(stream, {
      // @ts-ignore - hypercore types do not currently include this option
      ondiscoverykey: async (discoveryKey) => {
        const protomux =
          /** @type {import('protomux')<import('@hyperswarm/secret-stream')>} */ (
            replicationStream.noiseStream.userData
          )
        this.#syncApi[kHandleDiscoveryKey](discoveryKey, protomux)
      },
    })
    return replicationStream
  }

  /**
   * @param {Pick<import('@mapeo/schema').DeviceInfoValue, 'name' | 'deviceType'>} value
   * @returns {Promise<import('@mapeo/schema').DeviceInfo>}
   */
  async [kSetOwnDeviceInfo](value) {
    const { deviceInfo } = this.#dataTypes

    const configCoreId = this.#coreManager
      .getWriterCore('config')
      .key.toString('hex')

    const doc = {
      name: value.name,
      deviceType: value.deviceType,
      schemaName: /** @type {const} */ ('deviceInfo'),
    }

    let existingDoc
    try {
      existingDoc = await deviceInfo.getByDocId(configCoreId)
    } catch (err) {
      return await deviceInfo[kCreateWithDocId](configCoreId, doc)
    }

    return deviceInfo.update(existingDoc.versionId, doc)
  }

  /**
   * @returns {import('./icon-api.js').IconApi}
   */
  get $icons() {
    return this.#iconApi
  }

  async [kProjectLeave]() {
    // 1. Check that the device can leave the project
    const roleDocs = await this.#dataTypes.role.getMany()

    // 1.1 Check that we are not blocked in the project
    const ownRole = roleDocs.find(({ docId }) => this.#deviceId === docId)

    if (ownRole?.roleId === BLOCKED_ROLE_ID) {
      throw new Error('Cannot leave a project as a blocked device')
    }

    const allRoles = await this.#roles.getAll()

    // 1.2 Check that we are not the only device in the project
    if (allRoles.size <= 1) {
      throw new Error('Cannot leave a project as the only device')
    }

    // 1.3 Check if there are other known devices that are either the project creator or a coordinator
    const projectCreatorDeviceId = await this.#coreOwnership.getOwner(
      this.#projectId
    )
    let otherCreatorOrCoordinatorExists = false

    for (const deviceId of allRoles.keys()) {
      // Skip self (see 1.1 and 1.2 for relevant checks)
      if (deviceId === this.#deviceId) continue

      // Check if the device is the project creator first because
      // it is a derived role that is not stored in the role docs explicitly
      if (deviceId === projectCreatorDeviceId) {
        otherCreatorOrCoordinatorExists = true
        break
      }

      // Determine if the the device is a coordinator based on the role docs
      const isCoordinator = roleDocs.some(
        (doc) => doc.docId === deviceId && doc.roleId === COORDINATOR_ROLE_ID
      )

      if (isCoordinator) {
        otherCreatorOrCoordinatorExists = true
        break
      }
    }

    if (!otherCreatorOrCoordinatorExists) {
      throw new Error(
        'Cannot leave a project that does not have an external creator or another coordinator'
      )
    }

    // 2. Assign LEFT role for device
    await this.#roles.assignRole(this.#deviceId, LEFT_ROLE_ID)

    // 3. Clear data from cores
    // TODO: only clear synced data
    const namespacesWithoutAuth =
      /** @satisfies {Exclude<import('./core-manager/index.js').Namespace, 'auth'>[]} */ ([
        'config',
        'data',
        'blob',
        'blobIndex',
      ])

    await Promise.all(
      namespacesWithoutAuth.flatMap((namespace) => [
        this.#coreManager.getWriterCore(namespace).core.close(),
        this.#coreManager.deleteOthersData(namespace),
      ])
    )

    // 4. Clear data from indexes
    // 4.1 Reset multi-core indexer state
    await Promise.all(
      Object.values(this.#dataStores)
        .filter((dataStore) => dataStore.namespace !== 'auth')
        .map(async (dataStore) => {
          await dataStore.close()
          await dataStore.unlink()
        })
    )

    // 4.2 Clear indexed data
    /** @type {Set<string>} */
    const authSchemas = new Set(NAMESPACE_SCHEMAS.auth)
    for (const schemaName of this.#indexWriter.schemas) {
      const isAuthSchema = authSchemas.has(schemaName)
      if (!isAuthSchema) this.#indexWriter.deleteSchema(schemaName)
    }
  }

  /** @param {Object} opts
   *  @param {string} opts.configPath
   *  @returns {Promise<Error[]>}
   */
  async importConfig({ configPath }) {
    // check for already present fields and presets and delete them if exist
    await deleteAll(this.preset)
    await deleteAll(this.field)

    const config = await readConfig(configPath)
    /** @type {Map<string, string>} */
    const iconNameToId = new Map()
    /** @type {Map<string, string>} */
    const fieldNameToId = new Map()

    // Do this in serial not parallel to avoid memory issues (avoid keeping all icon buffers in memory)
    for await (const icon of config.icons()) {
      const iconId = await this.#iconApi.create(icon)
      iconNameToId.set(icon.name, iconId)
    }

    // Ok to create fields and presets in parallel
    const fieldPromises = []
    for (const { name, value } of config.fields()) {
      fieldPromises.push(
        this.#dataTypes.field.create(value).then(({ docId }) => {
          fieldNameToId.set(name, docId)
        })
      )
    }
    await Promise.all(fieldPromises)

    const presetsWithRefs = []
    for (const { fieldNames, iconName, value } of config.presets()) {
      const fieldIds = fieldNames.map((fieldName) => {
        const id = fieldNameToId.get(fieldName)
        if (!id) {
          throw new Error(
            `field ${fieldName} not found (referenced by preset ${value.name})})`
          )
        }
        return id
      })
      presetsWithRefs.push({
        ...value,
        iconId: iconName && iconNameToId.get(iconName),
        fieldIds,
      })
    }

    // close the zip handles after we know we won't be needing them anymore
    await config.close()

    const presetPromises = presetsWithRefs.map((preset) =>
      this.preset.create(preset)
    )
    const createdPresets = await Promise.all(presetPromises)
    const presetIds = createdPresets.map(({ docId }) => docId)

    await this.$setProjectSettings({
      defaultPresets: {
        point: presetIds,
        line: [],
        area: [],
        vertex: [],
        relation: [],
      },
    })

    return config.warnings
  }
}

/**
 * @param {import("@mapeo/schema").ProjectSettings & { forks: string[] }} projectDoc
 * @returns {EditableProjectSettings}
 */
function extractEditableProjectSettings(projectDoc) {
  // eslint-disable-next-line no-unused-vars
  const { schemaName, ...result } = valueOf(projectDoc)
  return result
}

// TODO: maybe a better signature than a bunch of any?
/** @param {DataType<any,any,any,any,any>} dataType */
async function deleteAll(dataType) {
  const deletions = []
  for (const { docId } of await dataType.getMany()) {
    deletions.push(dataType.delete(docId))
  }
  return Promise.all(deletions)
}

/**
 * Return a map of namespace -> core keypair
 *
 * For the project owner the keypair for the 'auth' namespace is the projectKey
 * and projectSecretKey. In all other cases keypairs are derived from the
 * project key
 *
 * @param {object} opts
 * @param {Buffer} opts.projectKey
 * @param {Buffer} [opts.projectSecretKey]
 * @param {import('@mapeo/crypto').KeyManager} opts.keyManager
 * @returns {Record<import('./core-manager/index.js').Namespace, import('./types.js').KeyPair>}
 */
function getCoreKeypairs({ projectKey, projectSecretKey, keyManager }) {
  const keypairs =
    /** @type {Record<import('./core-manager/index.js').Namespace, import('./types.js').KeyPair>} */ ({})

  for (const namespace of NAMESPACES) {
    keypairs[namespace] =
      namespace === 'auth' && projectSecretKey
        ? { publicKey: projectKey, secretKey: projectSecretKey }
        : keyManager.getHypercoreKeypair(namespace, projectKey)
  }

  return keypairs
}

/**
 * Validate that a deviceInfo record is written by the device that is it about,
 * e.g. version.coreKey should equal docId
 *
 * @param {import('@mapeo/schema').DeviceInfo} doc
 * @param {import('@mapeo/schema').VersionIdObject} version
 * @returns {import('@mapeo/schema').DeviceInfo}
 */
function mapAndValidateDeviceInfo(doc, { coreDiscoveryKey }) {
  if (!coreDiscoveryKey.equals(discoveryKey(Buffer.from(doc.docId, 'hex')))) {
    throw new Error(
      'Invalid deviceInfo record, cannot write deviceInfo for another device'
    )
  }
  return doc
}
