// @ts-check
import test from 'brittle'
import { abortSignalAny } from '../../src/lib/ponyfills.js'

test('abortSignalAny() handles empty iterables', (t) => {
  t.not(abortSignalAny([]).aborted, 'not immediately aborted')
  t.not(abortSignalAny(new Set()).aborted, 'not immediately aborted')
})

test('abortSignalAny() aborts immediately if one of the arguments was aborted', (t) => {
  const result = abortSignalAny([
    new AbortController().signal,
    AbortSignal.abort('foo'),
    AbortSignal.abort('ignored'),
    new AbortController().signal,
  ])

  t.ok(result.aborted, 'immediately aborted')
  t.is(result.reason, 'foo', 'gets first abort reason')
})

test('abortSignalAny() aborts as soon as one of its arguments aborts', (t) => {
  const a = new AbortController()
  const b = new AbortController()
  const c = new AbortController()

  const result = abortSignalAny([a.signal, b.signal, c.signal])

  t.not(result.aborted, 'not immediately aborted')

  b.abort('foo')
  c.abort('ignored')

  t.ok(result.aborted, 'aborted')
  t.is(result.reason, 'foo', 'gets first abort reason')
})

test('abortSignalAny() handles non-array iterables', (t) => {
  const a = new AbortController()
  const b = new AbortController()
  const c = new AbortController()

  const result = abortSignalAny(new Set([a.signal, b.signal, c.signal]))

  b.abort('foo')

  t.ok(result.aborted, 'aborted')
})
