import assert from 'node:assert/strict'
import test from 'node:test'
import { getOwn } from '../../src/lib/get-own.js'

test('getOwn', () => {
  class Foo {
    ownProperty = 123
    inheritedProperty() {
      return 789
    }
  }
  const foo = new Foo()
  assert.equal(getOwn(foo, 'ownProperty'), 123)
  assert.equal(getOwn(foo, 'inheritedProperty'), undefined)
  assert.equal(getOwn(foo, /** @type {any} */ ('hasOwnProperty')), undefined)
  assert.equal(getOwn(foo, /** @type {any} */ ('garbage')), undefined)

  const nullProto = Object.create(null)
  nullProto.foo = 123
  assert.equal(getOwn(nullProto, 'foo'), 123)
  assert.equal(getOwn(nullProto, 'garbage'), undefined)
  assert.equal(getOwn(nullProto, 'hasOwnProperty'), undefined)
})
