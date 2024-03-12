// @ts-check
import { validate } from '@mapeo/schema'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { eq, inArray, placeholder } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { deNullify } from '../utils.js'
import crypto from 'hypercore-crypto'
import { TypedEmitter } from 'tiny-typed-emitter'
import { parse as parseBCP47 } from 'bcp-47'
import { setProperty, hasProperty } from 'dot-prop'

/**
 * @typedef {import('@mapeo/schema').MapeoDoc} MapeoDoc
 */
/**
 * @typedef {import('@mapeo/schema').MapeoValue} MapeoValue
 */
/**
 * @typedef {import('../types.js').MapeoDocMap} MapeoDocMap
 */
/**
 * @typedef {import('../types.js').MapeoValueMap} MapeoValueMap
 */
/**
 * @typedef {`${MapeoDoc['schemaName']}Table`} MapeoDocTableName
 */
/**
 * @template T
 * @typedef {T[(keyof T) & MapeoDocTableName]} GetMapeoDocTables
 */
/**
 * Union of Drizzle schema tables that correspond to MapeoDoc types (e.g. excluding backlink tables and other utility tables)
 * @typedef {GetMapeoDocTables<typeof import('../schema/project.js')> | GetMapeoDocTables<typeof import('../schema/client.js')>} MapeoDocTables
 */
/**
 * @typedef {{ [K in MapeoDocTables['_']['name']]: Extract<MapeoDocTables, { _: { name: K }}> }} MapeoDocTablesMap
 */
/**
 * @template T
 * @template {keyof any} K
 * @typedef {T extends any ? Omit<T, K> : never} OmitUnion
 */
/**
 * @template {MapeoDoc} TDoc
 * @typedef {object} DataTypeEvents
 * @property {(docs: TDoc[]) => void} updated-docs
 */
/**
 * @typedef {string} LanguageCode
 */
/**
 * @typedef {object} TranslationRow
 * @property {LanguageCode} languageCode
 * @property {string} [regionCode]
 * @property {MapeoDoc['schemaName']} schemaNameRef
 * @property {string} docIdRef
 * @property {string} docId
 * @property {string} fieldRef
 * @property {string} message
 */
/**
 * @typedef {object} TranslationApi
 * @property {Map<LanguageCode, Set<MapeoDoc['schemaName']>>} translatedRecords
 * @property {(opts: Pick<TranslationRow, 'docIdRef' | 'schemaNameRef' | 'languageCode' | 'regionCode'>) => TranslationRow[]} get
 */

function generateId() {
  return randomBytes(32).toString('hex')
}
function generateDate() {
  return new Date().toISOString()
}
export const kCreateWithDocId = Symbol('kCreateWithDocId')
export const kSelect = Symbol('select')
export const kTable = Symbol('table')

/**
 * @template {import('../datastore/index.js').DataStore} TDataStore
 * @template {TDataStore['schemas'][number]} TSchemaName
 * @template {MapeoDocTablesMap[TSchemaName]} TTable
 * @template {Exclude<MapeoDocMap[TSchemaName], { schemaName: 'coreOwnership' }>} TDoc
 * @template {Exclude<MapeoValueMap[TSchemaName], { schemaName: 'coreOwnership' }>} TValue
 * @extends {TypedEmitter<DataTypeEvents<TDoc> & import('../types.js').DefaultEmitterEvents<DataTypeEvents<TDoc>>>}
 */
export class DataType extends TypedEmitter {
  #dataStore
  #table
  #getPermissions
  #schemaName
  #sql
  #db
  #translation

  /**
   *
   * @param {object} opts
   * @param {TTable} opts.table
   * @param {TDataStore} opts.dataStore
   * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} opts.db
   * @param {TranslationApi} opts.translation
   * @param {() => any} [opts.getPermissions]
   */
  constructor({ dataStore, table, getPermissions, db, translation }) {
    super()
    this.#dataStore = dataStore
    this.#table = table
    this.#schemaName = /** @type {TSchemaName} */ (getTableConfig(table).name)
    this.#getPermissions = getPermissions
    this.#db = db
    this.#translation = translation
    this.#sql = {
      getByDocId: db
        .select()
        .from(table)
        .where(eq(table.docId, placeholder('docId')))
        .prepare(),
      getMany: db
        .select()
        .from(table)
        .where(eq(table.deleted, false))
        .prepare(),
      getManyWithDeleted: db.select().from(table).prepare(),
    }
    this.on('newListener', (eventName) => {
      if (eventName !== 'updated-docs') return
      if (this.listenerCount('updated-docs') > 1) return
      if (this.#schemaName === 'projectSettings') return
      // Avoid adding a listener to the dataStore unless we need to (e.g. this has a listener attached), for performance reasons.
      this.#dataStore.on(this.#schemaName, this.#handleDataStoreUpdate)
    })
    this.on('removeListener', (eventName) => {
      if (eventName !== 'updated-docs') return
      if (this.listenerCount('updated-docs') > 0) return
      if (this.#schemaName === 'projectSettings') return
      this.#dataStore.off(this.#schemaName, this.#handleDataStoreUpdate)
    })
  }

  get [kTable]() {
    return this.#table
  }

  get writerCore() {
    return this.#dataStore.writerCore
  }

  /**
   * @template {import('type-fest').Exact<TValue, T>} T
   * @param {T} value
   */
  async create(value) {
    const docId = generateId()
    // @ts-expect-error - can't figure this one out, types in index.d.ts override this
    return this[kCreateWithDocId](docId, value, { checkExisting: false })
  }

  /**
   * @param {string} docId
   * @param {TValue | import('../types.js').CoreOwnershipWithSignaturesValue} value
   * @param {{ checkExisting?: boolean }} [opts] - only used internally to skip the checkExisting check when creating a document with a random ID (collisions should be too small probability to be worth checking for)
   */
  async [kCreateWithDocId](docId, value, { checkExisting = true } = {}) {
    if (!validate(this.#schemaName, value)) {
      // TODO: pass through errors from validate functions
      throw new Error('Invalid value ' + value)
    }
    if (checkExisting) {
      const existing = await this.getByDocId(docId).catch(noop)
      if (existing) {
        throw new Error('Doc with docId ' + docId + ' already exists')
      }
    }
    const nowDateString = generateDate()
    const discoveryId =
      this.#dataStore.writerCore.discoveryKey?.toString('hex') ||
      crypto.discoveryKey(this.#dataStore.writerCore.key).toString('hex')

    /** @type {OmitUnion<MapeoDoc, 'versionId'>} */
    const doc = {
      ...value,
      docId,
      createdAt: nowDateString,
      updatedAt: nowDateString,
      createdBy: discoveryId,
      deleted: false,
      links: [],
    }

    // TS can't track the relationship between TDoc and TValue, so doc above is
    // typed as MapeoDoc (without versionId) rather than as TDoc.
    await this.#dataStore.write(doc)
    return this.getByDocId(doc.docId)
  }

  /**
   * @param {string} docId
   * @param {{ lang?: string }} [opts]
   */
  async getByDocId(docId, { lang } = {}) {
    await this.#dataStore.indexer.idle()
    const result = /** @type {MapeoDoc} */ (this.#sql.getByDocId.get({ docId }))
    if (!result) throw new Error('Not found')
    return this.#translate(deNullify(result), { lang })
  }

  /**
   * @param {string} versionId
   * @param {{ lang?: string }} [opts]
   */
  async getByVersionId(versionId, { lang } = {}) {
    const result = await this.#dataStore.read(versionId)
    return this.#translate(result, { lang })
  }

  /**
   * @param {MapeoDoc} doc
   * @param {{ lang?: string }} [opts]
   */
  #translate(doc, { lang } = {}) {
    if (!lang) return doc
    const { language, region } = parseBCP47(lang)
    if (!language) return doc
    const translatedRecords = this.#translation.translatedRecords.get(language)
    // No translations indexed for this doc type, so don't try to translate
    if (!translatedRecords || !translatedRecords.has(this.#schemaName)) {
      return doc
    }
    const translations = this.#translation.get({
      languageCode: language,
      schemaNameRef: doc.schemaName,
      docIdRef: doc.docId,
    })
    const indexedTranslations = indexTranslations(translations)
    const translatedDoc = JSON.parse(JSON.stringify(doc))

    for (const [fieldRef, byRegionCode] of indexedTranslations.entries()) {
      if (!hasProperty(translatedDoc, fieldRef)) continue
      const t =
        byRegionCode.get(region === null ? undefined : region) ||
        byRegionCode.values().next().value
      if (!t) continue
      setProperty(translatedDoc, fieldRef, t.message)
    }

    return translatedDoc
  }

  /** @param {{ includeDeleted?: boolean, lang?: string }} [opts] */
  async getMany({ includeDeleted = false, lang } = {}) {
    await this.#dataStore.indexer.idle()
    const rows = includeDeleted
      ? this.#sql.getManyWithDeleted.all()
      : this.#sql.getMany.all()
    return rows.map((doc) =>
      this.#translate(
        // @ts-ignore - too complicated to type this
        deNullify(doc),
        { lang }
      )
    )
  }

  /**
   *
   * @template {import('type-fest').Exact<TValue, T>} T
   * @param {string | string[]} versionId
   * @param {T} value
   */
  async update(versionId, value) {
    await this.#dataStore.indexer.idle()
    const links = Array.isArray(versionId) ? versionId : [versionId]
    const { docId, createdAt, createdBy } = await this.#validateLinks(links)
    /** @type {any} */
    const doc = {
      ...value,
      docId,
      createdAt,
      updatedAt: new Date().toISOString(),
      createdBy,
      links,
    }
    await this.#dataStore.write(doc)
    return this.getByDocId(docId)
  }

  /**
   * @param {string} docId
   */
  async delete(docId) {
    await this.#dataStore.indexer.idle()
    const existingDoc = await this.getByDocId(docId)

    if ('deleted' in existingDoc && existingDoc.deleted) {
      throw new Error('Doc already deleted')
    }

    /** @type {any} */
    const doc = {
      ...existingDoc,
      updatedAt: new Date().toISOString(),
      links: [existingDoc.versionId, ...existingDoc.forks],
      deleted: true,
    }
    await this.#dataStore.write(doc)
    return this.getByDocId(docId)
  }

  /**
   * @param {Parameters<import('drizzle-orm/better-sqlite3').BetterSQLite3Database['select']>[0]} fields
   */
  async [kSelect](fields) {
    await this.#dataStore.indexer.idle()
    return this.#db.select(fields).from(this.#table)
  }

  /**
   * Validate that existing docs with the given versionIds (links):
   * - exist
   * - have the same schemaName as this dataType
   * - all share the same docId
   * - all share the same createdAt
   * Throws if any of these conditions fail, otherwise returns the validated
   * docId and createAt datetime
   * @param {string[]} links
   * @returns {Promise<{ docId: MapeoDoc['docId'], createdAt: MapeoDoc['createdAt'], createdBy: MapeoDoc['createdBy'] }>}
   */
  async #validateLinks(links) {
    const prevDocs = await Promise.all(
      links.map((versionId) => this.getByVersionId(versionId))
    )
    const { docId, createdAt, createdBy } = prevDocs[0]
    const areLinksValid = prevDocs.every(
      (doc) =>
        doc.docId === docId &&
        doc.schemaName === this.#schemaName &&
        doc.createdBy === createdBy
    )
    if (!areLinksValid) {
      throw new Error('Updated docs must have the same docId and schemaName')
    }
    return { docId, createdAt, createdBy }
  }

  /**
   * @param {Set<string>} docIds
   */
  #handleDataStoreUpdate = (docIds) => {
    if (this.listenerCount('updated-docs') === 0) return
    const updatedDocs = /** @type {TDoc[]} */ (
      this.#db
        .select()
        .from(this.#table)
        .where(inArray(this.#table.docId, [...docIds]))
        .all()
        .map((doc) => deNullify(doc))
    )
    this.emit('updated-docs', updatedDocs)
  }
}

function noop() {}

/**
 * @typedef {Map<TranslationRow['fieldRef'], Map<TranslationRow['regionCode'], TranslationRow>>} TranslationIndex
 */

/**
 * @param {TranslationRow[]} translations
 * @returns {TranslationIndex}
 */
function indexTranslations(translations) {
  /** @type {TranslationIndex} */
  const index = new Map()
  for (const t of translations) {
    let byRegionCode = index.get(t.fieldRef)
    if (!byRegionCode) {
      byRegionCode = new Map()
      index.set(t.fieldRef, byRegionCode)
    }
    // There should never be more than one entry here, due to constraints on how
    // translation IDs are generated, and translations are then indexed
    byRegionCode.set(t.regionCode, t)
  }
  return index
}
