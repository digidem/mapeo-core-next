// @ts-check

/**
 * Ponyfill of `AbortSignal.any()`.
 *
 * [0]: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
 *
 * @param {Iterable<AbortSignal>} iterable
 * @returns {AbortSignal}
 */
export function abortSignalAny(iterable) {
  for (const signal of iterable) {
    if (signal.aborted) return AbortSignal.abort(signal.reason)
  }

  /** @type {Array<() => unknown>} */
  const listeners = []
  const controller = new AbortController()

  for (const signal of iterable) {
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', listener)
    listeners.push(listener)
  }

  return controller.signal
}
