import { validate } from '@comapeo/schema'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { eq, inArray, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { noop, deNullify } from '../utils.js'
import { NotFoundError } from '../errors.js'
import { TypedEmitter } from 'tiny-typed-emitter'
import { parse as parseBCP47 } from 'bcp-47'
import { setProperty, getProperty } from 'dot-prop'
/** @import { MapeoDoc, MapeoValue } from '@comapeo/schema' */
/** @import { MapeoDocMap, MapeoValueMap } from '../types.js' */
/** @import { DataStore } from '../datastore/index.js' */

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

function generateId() {
  return randomBytes(32).toString('hex')
}
function generateDate() {
  return new Date().toISOString()
}
export const kCreateWithDocId = Symbol('kCreateWithDocId')
export const kSelect = Symbol('select')
export const kTable = Symbol('table')
export const kDataStore = Symbol('dataStore')

/**
 * @template {DataStore} TDataStore
 * @template {Exclude<TDataStore['schemas'][number], 'remoteDetectionAlert'>} TSchemaName TODO: Remove this exclusion
 * @template {MapeoDocTablesMap[TSchemaName]} TTable
 * @template {Exclude<MapeoDocMap[TSchemaName], { schemaName: 'coreOwnership' }>} TDoc
 * @template {Exclude<MapeoValueMap[TSchemaName], { schemaName: 'coreOwnership' }>} TValue
 * @extends {TypedEmitter<DataTypeEvents<TDoc> & import('../types.js').DefaultEmitterEvents<DataTypeEvents<TDoc>>>}
 */
export class DataType extends TypedEmitter {
  #dataStore
  #table
  #schemaName
  #sql
  #db
  #getTranslations

  /**
   *
   * @param {object} opts
   * @param {TTable} opts.table
   * @param {TDataStore} opts.dataStore
   * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} opts.db
   * @param {import('../translation-api.js').default['get']} opts.getTranslations
   */
  constructor({ dataStore, table, db, getTranslations }) {
    super()
    this.#dataStore = dataStore
    this.#table = table
    this.#schemaName = /** @type {TSchemaName} */ (getTableConfig(table).name)
    this.#db = db
    this.#getTranslations = getTranslations
    this.#sql = {
      getByDocId: db
        .select()
        .from(table)
        .where(eq(table.docId, sql.placeholder('docId')))
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

  get schemaName() {
    return this.#schemaName
  }

  get namespace() {
    return this.#dataStore.namespace
  }

  get [kDataStore]() {
    return this.#dataStore
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

    /** @type {Parameters<typeof DataStore.prototype.write>[0]} */
    const doc = {
      ...value,
      docId,
      createdAt: nowDateString,
      updatedAt: nowDateString,
      deleted: false,
      links: [],
    }
    await this.#dataStore.write(doc)
    return this.getByDocId(doc.docId)
  }

  /**
   * @param {string} docId
   * @param {{ lang?: string }} [opts]
   */
  async getByDocId(docId, { lang } = {}) {
    await this.#dataStore.indexer.idle()
    const result = /** @type {undefined | MapeoDoc} */ (
      this.#sql.getByDocId.get({ docId })
    )
    if (!result) throw new NotFoundError()
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
  async #translate(doc, { lang } = {}) {
    if (!lang) return doc

    const { language, region } = parseBCP47(lang)
    if (!language) return doc
    const translatedDoc = JSON.parse(JSON.stringify(doc))

    const value = {
      languageCode: language,
      docRef: {
        docId: translatedDoc.docId,
        versionId: translatedDoc.versionId,
      },
      docRefType: translatedDoc.schemaName,
      regionCode: region !== null ? region : undefined,
    }
    let translations = await this.#getTranslations(value)
    // if passing a region code returns no matches,
    // fallback to matching only languageCode
    if (translations.length === 0 && value.regionCode) {
      value.regionCode = undefined
      translations = await this.#getTranslations(value)
    }

    for (const translation of translations) {
      if (typeof getProperty(doc, translation.propertyRef) === 'string') {
        setProperty(doc, translation.propertyRef, translation.message)
      }
    }
    return doc
  }

  /** @param {{ includeDeleted?: boolean, lang?: string }} [opts] */
  async getMany({ includeDeleted = false, lang } = {}) {
    await this.#dataStore.indexer.idle()
    const rows = includeDeleted
      ? this.#sql.getManyWithDeleted.all()
      : this.#sql.getMany.all()
    return await Promise.all(
      rows.map(
        async (doc) =>
          await this.#translate(deNullify(/** @type {MapeoDoc} */ (doc)), {
            lang,
          })
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
    const { docId, createdAt, originalVersionId } = await this.#validateLinks(
      links
    )
    /** @type {any} */
    const doc = {
      // @ts-expect-error Can't figure out why TypeScript doesn't think `value` is spreadable.
      ...value,
      docId,
      createdAt,
      updatedAt: new Date().toISOString(),
      originalVersionId,
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
      // @ts-expect-error - TS just doesn't work in this class
      links: [existingDoc.versionId, ...existingDoc.forks],
      deleted: true,
    }
    await this.#dataStore.write(doc)
    return this.getByDocId(docId)
  }

  async [kSelect]() {
    await this.#dataStore.indexer.idle()
    const result = this.#db.select().from(this.#table)
    // [The result of `from()` is awaitable.][0] We don't want this because we
    // want to be able to await the result of this method and then call
    // `.where()` on the result.
    //
    // As a workaround, we remove promise methods from the result.
    //
    // [0]: https://github.com/drizzle-team/drizzle-orm/commit/c063144dc08726cc15323582fe377210329e579e
    return removePromiseMethods(result)
  }

  /**
   * Validate that existing docs with the given versionIds (links):
   * - exist
   * - have the same schemaName as this dataType
   * - all share the same docId
   * - all share the same originalVersionId
   * Throws if any of these conditions fail, otherwise returns the validated
   * docId and createAt datetime
   * @param {string[]} links
   * @returns {Promise<{ docId: MapeoDoc['docId'], createdAt: MapeoDoc['createdAt'], originalVersionId: MapeoDoc['originalVersionId'] }>}
   */
  async #validateLinks(links) {
    const prevDocs = await Promise.all(
      links.map((versionId) => this.getByVersionId(versionId))
    )
    const { docId, createdAt, originalVersionId } = prevDocs[0]
    const areLinksValid = prevDocs.every(
      (doc) =>
        doc.docId === docId &&
        doc.schemaName === this.#schemaName &&
        doc.originalVersionId === originalVersionId
    )
    if (!areLinksValid) {
      throw new Error('Updated docs must have the same docId and schemaName')
    }
    return { docId, createdAt, originalVersionId }
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

/**
 * @template {object} T
 * @param {T} value
 * @returns {Omit<T, 'then' | 'catch' | 'finally'> & { then?: undefined, catch?: undefined, finally?: undefined }}
 */
function removePromiseMethods(value) {
  return Object.create(value, {
    then: { value: undefined },
    catch: { value: undefined },
    finally: { value: undefined },
  })
}
