import { text, sqliteTable } from 'drizzle-orm/sqlite-core'

export const foo = sqliteTable('foo', { bar: text('bar') })

export const baz = sqliteTable('baz', { qux: text('qux') })
