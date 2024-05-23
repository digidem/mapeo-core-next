import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import drizzleMigrate from '../../src/lib/drizzle-migrate.js'

const __filename = fileURLToPath(import.meta.url)
const fixturesPath = path.join(__filename, '..', '..', 'fixtures', 'schemas')

/**
 * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} db
 * @returns {Set<string>}
 */
const getTableNames = (db) => {
  /** @type {Set<string>} */ const result = new Set()

  const tables = db.all(
    sql`SELECT name FROM sqlite_master WHERE type IS 'table'`
  )
  for (const table of tables) {
    if (
      table &&
      typeof table === 'object' &&
      'name' in table &&
      typeof table.name === 'string'
    ) {
      result.add(table.name)
    }
  }

  return result
}

test('migration results', () => {
  const db = drizzle(new Database(':memory:'))
  const migrationsTable = 'test_drizzle_migrate'

  const migration1 = drizzleMigrate(db, {
    migrationsFolder: path.join(fixturesPath, 'one_table'),
    migrationsTable,
  })
  assert.equal(migration1, 'migrated from scratch')

  const migration2 = drizzleMigrate(db, {
    migrationsFolder: path.join(fixturesPath, 'two_tables'),
    migrationsTable,
  })
  assert.equal(migration2, 'migrated something')

  const migration3 = drizzleMigrate(db, {
    migrationsFolder: path.join(fixturesPath, 'two_tables'),
    migrationsTable,
  })
  assert.equal(migration3, 'no migration')

  const tableNames = getTableNames(db)
  assert(tableNames.has('foo'), 'first migration ran')
  assert(tableNames.has('baz'), 'second migration ran')
})

test('error when passing an invalid migration table name', () => {
  const db = drizzle(new Database(':memory:'))

  assert.throws(() => {
    drizzleMigrate(db, {
      migrationsFolder: path.join(fixturesPath, 'one_table'),
      migrationsTable: '',
    })
  })

  const tableNames = getTableNames(db)
  assert(!tableNames.has('foo'), "migrations didn't run")
})
