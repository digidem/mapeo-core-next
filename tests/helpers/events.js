// @ts-check
import { assert } from '../../src/utils.js'
import { pEventIterator } from 'p-event'
import { arrayFrom } from 'iterpal'

/**
 * Like `once`, but listens to events up to a certain number of times.
 *
 * @param {import('node:events').EventEmitter} emitter
 * @param {string | symbol} eventName
 * @param {number} count
 * @returns {Promise<unknown[][]>}
 */
export function onTimes(emitter, eventName, count) {
  assert(
    Number.isSafeInteger(count) && count >= 0,
    'onTimes called with an invalid count'
  )

  const events = pEventIterator(emitter, eventName, {
    multiArgs: true,
    limit: count,
  })
  return arrayFrom(events)
}
