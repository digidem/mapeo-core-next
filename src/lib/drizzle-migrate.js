import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash } from 'node:crypto'
import { assert } from '../utils.js'
import { isNameSafe } from './sqlite.js'

/**
 * @param {(
 *   import('drizzle-orm/sqlite-core').SQLiteTransaction<
 *     'sync',
 *     import('better-sqlite3').RunResult,
 *     Record<string, unknown>,
 *     any
 *   >
 * )} tx
 * @param {string} tableName
 * @returns {boolean}
 */
const doesTableExist = (tx, tableName) => {
  const query = sql`SELECT (
    SELECT EXISTS (
      SELECT 1 FROM sqlite_master
      WHERE type IS 'table'
      AND name IS ${tableName}
    )
  ) AS result`
  const row = tx.get(query)
  return Boolean(
    row && typeof row === 'object' && 'result' in row && row.result === 1
  )
}

/**
 * @param {unknown} value
 * @returns {string | import('type-fest').TypedArray}
 */
const hashRowValue = (value) => {
  switch (typeof value) {
    case 'string':
      return value
    case 'object':
      if (value instanceof Uint8Array) {
        return value
      } else {
        return JSON.stringify(value)
      }
    case 'number':
    case 'bigint':
    case 'boolean': // boolean should be impossible, but easy to check here.
      return value.toString()
    default:
      return ''
  }
}

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {string} tableName
 * @returns {null | Buffer}
 */
const hashRows = (db, tableName) =>
  db.transaction((tx) => {
    if (!doesTableExist(tx, tableName)) return null

    const hash = createHash('sha256')

    const migrationRowsQuery = sql.raw(`SELECT * FROM ${tableName}`)
    for (const rowValues of tx.values(migrationRowsQuery)) {
      for (const rowValue of rowValues) hash.update(hashRowValue(rowValue))
    }

    return hash.digest()
  })

/**
 * A version of drizzle-orm's `migrate` that returns the migration result.
 *
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @param {object} options
 * @param {string} options.migrationsFolder
 * @param {string} options.migrationsTable
 * @returns {'migrated from scratch' | 'migrated something' | 'no migration'}
 */
export default function drizzleMigrate(db, options) {
  const { migrationsTable } = options

  assert(isNameSafe(migrationsTable), 'Migration table name is possibly unsafe')

  const hashBeforeMigration = hashRows(db, migrationsTable)

  migrate(db, options)

  const hashAfterMigration = hashRows(db, migrationsTable)

  if (!hashBeforeMigration && !hashAfterMigration) {
    return 'no migration'
  }

  if (!hashBeforeMigration) {
    return 'migrated from scratch'
  }

  assert(hashAfterMigration, 'unexpected removal of migrations')

  return hashBeforeMigration.equals(hashAfterMigration)
    ? 'no migration'
    : 'migrated something'
}
