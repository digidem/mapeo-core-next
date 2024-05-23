import assert from 'node:assert/strict'
import test from 'node:test'
import { isNameSafe } from '../../src/lib/sqlite.js'

test('isNameSafe', () => {
  const unsafeNames = [
    '',
    ' table',
    '1table',
    "'table'",
    'táble',
    'sqlite',
    'sqlite_master',
    'SQLITE_master',
    'x'.repeat(2000),
  ]
  for (const unsafeName of unsafeNames) {
    assert(!isNameSafe(unsafeName), `${JSON.stringify(unsafeName)} is unsafe`)
  }

  const safeNames = ['table', 'table_name', 'table1', '_table']
  for (const safeName of safeNames) {
    assert(isNameSafe(safeName), `${JSON.stringify(safeName)} is safe`)
  }
})
