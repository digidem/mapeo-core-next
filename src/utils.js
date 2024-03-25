import b4a from 'b4a'
import { keyToPublicId } from '@mapeo/crypto'
import { createHash } from 'node:crypto'
import stableStringify from 'json-stable-stringify'

/**
 * @param {String|Buffer} id
 * @returns {Buffer | Uint8Array}
 */
export function idToKey(id) {
  if (b4a.isBuffer(id)) {
    return /** @type {Buffer} */ (id)
  }

  return b4a.from(/** @type {String} */ (id), 'hex')
}

/**
 *
 * @param {Buffer|String} key
 * @returns {String}
 */
export function keyToId(key) {
  if (typeof key === 'string') {
    return key
  }

  return key.toString('hex')
}

/**
 * @param {String} version
 * @returns {{coreId: String, blockIndex: Number}}
 */
export function parseVersion(version) {
  const [coreId, blockIndex] = version.split('@')
  return {
    coreId,
    blockIndex: Number(blockIndex),
  }
}

/**
 * Truncate a key or id to a string with a given length with a default of 3 characters.
 * @param {String|Buffer} keyOrId
 */
export function truncateId(keyOrId, length = 3) {
  return keyToId(keyOrId).slice(0, length)
}

/** @typedef {import('@hyperswarm/secret-stream')<any>} NoiseStream */
/** @typedef {NoiseStream & { destroyed: true }} DestroyedNoiseStream */
/**
 * @template {import('node:stream').Duplex | import('streamx').Duplex} [T=import('node:stream').Duplex | import('streamx').Duplex]
 * @typedef {import('@hyperswarm/secret-stream')<T> & { publicKey: Buffer, remotePublicKey: Buffer, handshake: Buffer }} OpenedNoiseStream
 */

/**
 * Utility to await a NoiseSecretStream to open, that returns a stream with the
 * correct types for publicKey and remotePublicKey (which can be null before
 * stream is opened)
 *
 * @param {NoiseStream} stream
 * @returns {Promise<OpenedNoiseStream | DestroyedNoiseStream>}
 */
export async function openedNoiseSecretStream(stream) {
  await stream.opened
  return /** @type {OpenedNoiseStream | DestroyedNoiseStream} */ (stream)
}

export class ExhaustivenessError extends Error {
  /** @param {never} value */
  constructor(value) {
    super(`Exhaustiveness check failed. ${value} should be impossible`)
    this.name = 'ExhaustivenessError'
  }
}

/**
 * @returns {void}
 */
export function noop() {}

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Return a function that itself returns whether a value is part of the set.
 *
 * Similar to binding `Set.prototype.has`, but (1) is shorter (2) refines the type.
 *
 * @template T
 * @param {Readonly<Set<T>>} set
 * @example
 * const mySet = new Set([1, 2, 3])
 * const isInMySet = setHas(mySet)
 *
 * console.log(isInMySet(2))
 * // => true
 */
export function setHas(set) {
  /**
   * @param {unknown} value
   * @returns {value is T}
   */
  return (value) => set.has(/** @type {*} */ (value))
}

/**
 * When reading from SQLite, any optional properties are set to `null`. This
 * converts `null` back to `undefined` to match the input types (e.g. the types
 * defined in @mapeo/schema)
 * @template {{}} T
 * @param {T} obj
 * @returns {import('./types.js').NullableToOptional<T>}
 */

export function deNullify(obj) {
  /** @type {Record<string, any>} */
  const objNoNulls = {}
  for (const [key, value] of Object.entries(obj)) {
    objNoNulls[key] = value === null ? undefined : value
  }
  return /** @type {import('./types.js').NullableToOptional<T>} */ (objNoNulls)
}

/**
 * @template {import('@mapeo/schema').MapeoDoc & { forks?: string[] }} T
 * @param {T} doc
 * @returns {Omit<T, 'docId' | 'versionId' | 'links' | 'forks' | 'createdAt' | 'updatedAt' | 'createdBy' | 'deleted'>}
 */
export function valueOf(doc) {
  /* eslint-disable no-unused-vars */
  const {
    docId,
    versionId,
    links,
    forks,
    createdAt,
    updatedAt,
    createdBy,
    deleted,
    ...rest
  } = doc
  /* eslint-enable no-unused-vars */
  return rest
}

/**
 * Create an internal ID from a project key
 * @param {Buffer} projectKey
 * @returns {string}
 */
export function projectKeyToId(projectKey) {
  return projectKey.toString('hex')
}

/**
 * Create a public ID from a project key
 * @param {Buffer} projectKey
 * @returns {string}
 */
export function projectKeyToPublicId(projectKey) {
  return keyToPublicId(projectKey)
}

/**
 * @param {string} projectId Project internal ID
 * @returns {Buffer} 24-byte nonce (same length as sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
 */
export function projectIdToNonce(projectId) {
  return Buffer.from(projectId, 'hex').subarray(0, 24)
}

/**
 * @param {import('@mapeo/crypto').KeyManager} keyManager
 * @returns {string}
 */
export function getDeviceId(keyManager) {
  return keyManager.getIdentityKeypair().publicKey.toString('hex')
}

/**
 * Small helper to create a typed map
 *
 * @template {string} K
 * @template {any} V
 * @param {ReadonlyArray<K>} keys
 * @param {V} value
 * @returns {Record<K, V extends () => infer T ? T : V>} */
export function createMap(keys, value) {
  const map = /** @type {Record<K, V extends () => infer T ? T : V>} */ ({})
  for (const key of keys) {
    map[key] = typeof value === 'function' ? value() : value
  }
  return map
}

/**
 * create a sha256 hash of an object using json-stable-stringify for deterministic results
 * @param {Object} obj
 * @returns {String} hash of the object
 */
export function hashObject(obj) {
  return createHash('sha256')
    .update(stableStringify(obj))
    .digest()
    .toString('hex')
}
