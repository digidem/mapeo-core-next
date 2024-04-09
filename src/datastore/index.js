import { TypedEmitter } from 'tiny-typed-emitter'
import { encode, decode, getVersionId, parseVersionId } from '@mapeo/schema'
import MultiCoreIndexer from 'multi-core-indexer'
import pDefer from 'p-defer'
import { discoveryKey } from 'hypercore-crypto'
import { createMap } from '../utils.js'

/**
 * @typedef {import('@mapeo/schema').MapeoDoc} MapeoDoc
 */
/**
 * @typedef {import('../datatype/index.js').MapeoDocTablesMap} MapeoDocTablesMap
 */
/**
 * For each schemaName in this dataStore, emits an array of docIds that have
 * been indexed whenever indexing finishes (becomes idle). `projectSettings`
 * currently not supported.
 *
 * @template {MapeoDoc['schemaName']} TSchemaName
 * @typedef {{
 *   [S in Exclude<TSchemaName, 'projectSettings'>]: (docIds: Set<string>) => void
 * }} DataStoreEvents
 */
/**
 * @template T
 * @template {keyof any} K
 * @typedef {T extends any ? Omit<T, K> : never} OmitUnion
 */

const NAMESPACE_SCHEMAS = /** @type {const} */ ({
  data: ['observation'],
  config: [
    'translation',
    'preset',
    'field',
    'projectSettings',
    'deviceInfo',
    'icon',
  ],
  auth: ['coreOwnership', 'membership'],
})

/**
 * @typedef {typeof NAMESPACE_SCHEMAS} NamespaceSchemas
 */

/**
 * @template {keyof NamespaceSchemas} [TNamespace=keyof NamespaceSchemas]
 * @template {NamespaceSchemas[TNamespace][number]} [TSchemaName=NamespaceSchemas[TNamespace][number]]
 * @extends {TypedEmitter<DataStoreEvents<TSchemaName>>}
 */
export class DataStore extends TypedEmitter {
  #coreManager
  #namespace
  #batch
  #writerCore
  #coreIndexer
  /** @type {Map<string, import('p-defer').DeferredPromise<void>>} */
  #pendingIndex = new Map()
  /** @type {Set<import('p-defer').DeferredPromise<void>['promise']>} */
  #pendingAppends = new Set()
  /** @type {Record<MapeoDoc['schemaName'], Set<string>>} */
  #pendingEmits

  /**
   * @param {object} opts
   * @param {import('../core-manager/index.js').CoreManager} opts.coreManager
   * @param {TNamespace} opts.namespace
   * @param {(entries: MultiCoreIndexer.Entry<'binary'>[]) => Promise<import('../index-writer/index.js').IndexedDocIds>} opts.batch
   * @param {MultiCoreIndexer.StorageParam} opts.storage
   */
  constructor({ coreManager, namespace, batch, storage }) {
    super()
    this.#coreManager = coreManager
    this.#namespace = namespace
    this.#batch = batch
    this.#pendingEmits = createMap(
      NAMESPACE_SCHEMAS[namespace],
      () => new Set()
    )
    this.#writerCore = coreManager.getWriterCore(namespace).core
    const cores = coreManager.getCores(namespace).map((cr) => cr.core)
    this.#coreIndexer = new MultiCoreIndexer(cores, {
      storage,
      batch: (entries) => this.#handleEntries(entries),
    })
    coreManager.on('add-core', (coreRecord) => {
      if (coreRecord.namespace !== namespace) return
      this.#coreIndexer.addCore(coreRecord.core)
    })
    this.#coreIndexer.on('idle', this.#handleIndexerIdle)
  }

  get indexer() {
    return this.#coreIndexer
  }

  get namespace() {
    return this.#namespace
  }

  get schemas() {
    // Return a shallow copy (slice(0)) to avoid mutation bugs
    return NAMESPACE_SCHEMAS[this.#namespace].slice(0)
  }

  get writerCore() {
    return this.#writerCore
  }

  getIndexState() {
    return this.#coreIndexer.state
  }

  /**
   *
   * @param {MultiCoreIndexer.Entry<'binary'>[]} entries
   */
  async #handleEntries(entries) {
    const indexed = await this.#batch(entries)
    await Promise.all(this.#pendingAppends)
    // Writes to the writerCore need to wait until the entry is indexed before
    // returning, so we check if any incoming entry has a pending promise
    for (const entry of entries) {
      if (!entry.key.equals(this.#writerCore.key)) continue
      const versionId = getVersionId({
        coreDiscoveryKey: discoveryKey(entry.key),
        index: entry.index,
      })
      const pending = this.#pendingIndex.get(versionId)
      if (!pending) continue
      pending.resolve()
    }
    for (const schemaName of this.schemas) {
      // Unsupported initially
      if (schemaName === 'projectSettings') continue
      const docIds = indexed[schemaName]
      if (!docIds) continue
      for (const docId of docIds) {
        // We'll only emit these once the indexer is idle - a particular docId
        // could have many updates, and we only emit it once after indexing
        this.#pendingEmits[schemaName].add(docId)
      }
    }
  }

  /**
   * UNSAFE: Does not check links: [] refer to a valid doc - should only be used
   * internally.
   *
   * Write a doc, must be one of the schema types supported by the namespace of
   * this DataStore.
   * @template {Extract<Parameters<encode>[0], { schemaName: TSchemaName }>} TDoc
   * @param {TDoc} doc
   * @returns {Promise<Extract<MapeoDoc, TDoc>>}
   */
  async write(doc) {
    // @ts-ignore
    if (!NAMESPACE_SCHEMAS[this.#namespace].includes(doc.schemaName)) {
      throw new Error(
        `Schema '${doc.schemaName}' is not allowed in namespace '${
          this.#namespace
        }'`
      )
    }
    const block = encode(doc)
    // The indexer batch can sometimes complete before the append below
    // resolves, so in the batch function we await any pending appends. We can't
    // know the versionId before the append, because docs can be written in the
    // same tick, so we can't know their index before append resolves.
    const deferredAppend = pDefer()
    this.#pendingAppends.add(deferredAppend.promise)
    const { length } = await this.#writerCore.append(block)
    deferredAppend.resolve()
    this.#pendingAppends.delete(deferredAppend.promise)

    const index = length - 1
    const coreDiscoveryKey = this.#writerCore.discoveryKey
    if (!coreDiscoveryKey) {
      throw new Error('Writer core is not ready')
    }
    const versionId = getVersionId({ coreDiscoveryKey, index })
    /** @type {import('p-defer').DeferredPromise<void>} */
    const deferred = pDefer()
    this.#pendingIndex.set(versionId, deferred)
    await deferred.promise

    return /** @type {Extract<MapeoDoc, TDoc>} */ (
      decode(block, { coreDiscoveryKey, index })
    )
  }

  /**
   *
   * @param {string} versionId
   * @returns {Promise<MapeoDoc>}
   */
  async read(versionId) {
    const { coreDiscoveryKey, index } = parseVersionId(versionId)
    const coreRecord = this.#coreManager.getCoreByDiscoveryKey(coreDiscoveryKey)
    if (!coreRecord) throw new Error('Invalid versionId')
    const block = await coreRecord.core.get(index, { wait: false })
    if (!block) throw new Error('Not Found')
    return decode(block, { coreDiscoveryKey, index })
  }

  /** @param {Buffer} buf */
  async writeRaw(buf) {
    const { length } = await this.#writerCore.append(buf)
    const index = length - 1
    const coreDiscoveryKey = this.#writerCore.discoveryKey
    if (!coreDiscoveryKey) {
      throw new Error('Writer core is not ready')
    }
    const versionId = getVersionId({ coreDiscoveryKey, index })
    return versionId
  }

  /** @param {string} versionId */
  async readRaw(versionId) {
    const { coreDiscoveryKey, index } = parseVersionId(versionId)
    const coreRecord = this.#coreManager.getCoreByDiscoveryKey(coreDiscoveryKey)
    if (!coreRecord) throw new Error('core not found')
    const block = await coreRecord.core.get(index, { wait: false })
    if (!block) throw new Error('Not Found')
    return block
  }

  async close() {
    await this.#coreIndexer.close()
  }
  #handleIndexerIdle = () => {
    for (const eventName of this.eventNames()) {
      if (!(eventName in this.#pendingEmits)) continue
      const docIds = this.#pendingEmits[eventName]
      if (!docIds.size) continue
      // @ts-ignore - I'm pretty sure TS is just not smart enough here, it's not me!
      this.emit(eventName, docIds)
    }
    // Make sure we reset this, otherwise we'd get a memory leak of this growing without bounds.
    this.#pendingEmits = createMap(this.schemas, () => new Set())
  }
}
