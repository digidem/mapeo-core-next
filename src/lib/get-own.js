/**
 * @template {object} T
 * @template {keyof T} K
 * @param {T} obj
 * @param {K} key
 * @returns {undefined | T[K]}
 */
export function getOwn(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}
