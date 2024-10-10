import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import util from 'node:util'
import { discoveryKey } from 'hypercore-crypto'
import { TypedEmitter } from 'tiny-typed-emitter'
import { LiveDownload } from './live-download.js'
/** @import { JsonObject } from 'type-fest' */
/** @import { BlobId } from '../types.js' */

/** @typedef {TypedEmitter<{ 'add-drive': (drive: import('hyperdrive')) => void }>} InternalDriveEmitter */

// prop = blob type name
// value = array of blob variants supported for that type
const SUPPORTED_BLOB_VARIANTS = /** @type {const} */ ({
  photo: ['original', 'preview', 'thumbnail'],
  audio: ['original'],
  video: ['original'],
})

// Cannot directly export the const assignment above because export does not
// like the assignment being wrapped in parenthesis, which is necessary to cast
// the type with JSDoc
export { SUPPORTED_BLOB_VARIANTS }

class ErrNotFound extends Error {
  constructor(message = 'NotFound') {
    super(message)
    this.code = 'ENOENT'
  }
}

export class BlobStore {
  /** @type {Map<string, Hyperdrive>} Indexed by hex-encoded discovery key */
  #hyperdrives = new Map()
  #writer
  /**
   * Used to communicate to live download instances when new drives are added
   * @type {InternalDriveEmitter}
   */
  #driveEmitter = new TypedEmitter()

  /**
   * @param {object} options
   * @param {import('../core-manager/index.js').CoreManager} options.coreManager
   */
  constructor({ coreManager }) {
    /** @type {undefined | (Hyperdrive & { key: Buffer })} */
    let writer
    const corestore = new PretendCorestore({ coreManager })
    const blobIndexCores = coreManager.getCores('blobIndex')
    const { key: writerKey } = coreManager.getWriterCore('blobIndex')
    for (const { key } of blobIndexCores) {
      // @ts-ignore - we know pretendCorestore is not actually a Corestore
      const drive = new Hyperdrive(corestore, key)
      // We use the discovery key to derive the id for a drive
      this.#hyperdrives.set(getDiscoveryId(key), drive)
      if (key.equals(writerKey)) {
        writer = proxyProps(drive, { key: writerKey })
      }
    }
    if (!writer) {
      throw new Error('Could not find a writer for the blobIndex namespace')
    }
    this.#writer = writer

    coreManager.on('add-core', ({ key, namespace }) => {
      if (namespace !== 'blobIndex') return
      // We use the discovery key to derive the id for a drive
      const driveId = getDiscoveryId(key)
      if (this.#hyperdrives.has(driveId)) return
      // @ts-ignore - we know pretendCorestore is not actually a Corestore
      const drive = new Hyperdrive(corestore, key)
      this.#hyperdrives.set(driveId, drive)
      this.#driveEmitter.emit('add-drive', drive)
    })
  }

  get writerDriveId() {
    return getDiscoveryId(this.#writer.key)
  }

  /**
   * @param {string} driveId hex-encoded discovery key
   */
  #getDrive(driveId) {
    const drive = this.#hyperdrives.get(driveId)
    if (!drive) throw new Error('Drive not found ' + driveId.slice(0, 7))
    return drive
  }

  /**
   * @param {BlobId} blobId
   * @param {object} opts
   * @param {false} [opts.wait=false] Set to `true` to wait for a blob to download, otherwise will throw if blob is not available locally
   * @param {never} [opts.timeout] Optional timeout to wait for a blob to download
   */
  async get({ type, variant, name, driveId }, { wait = false, timeout } = {}) {
    const drive = this.#getDrive(driveId)
    const path = makePath({ type, variant, name })
    const blob = await drive.get(path, { wait, timeout })
    if (!blob) throw new ErrNotFound()
    return blob
  }

  /**
   * Download blobs from all drives, optionally filtering particular blob types
   * or blob variants. Download will be 'live' and will continue downloading new
   * data as it becomes available from any replicating drive.
   *
   * If no filter is specified, all blobs will be downloaded. If a filter is
   * specified, then _only_ blobs that match the filter will be downloaded.
   *
   * @param {import('../types.js').BlobFilter} [filter] Filter blob types and/or variants to download. Filter is { [BlobType]: BlobVariants[] }. At least one blob variant must be specified for each blob type.
   * @param {object} options
   * @param {AbortSignal} [options.signal] Optional AbortSignal to cancel in-progress download
   * @returns EventEmitter with `.state` propery, emits `state` with new state when it updates
   */
  download(filter, { signal } = {}) {
    return new LiveDownload(this.#hyperdrives.values(), this.#driveEmitter, {
      filter,
      signal,
    })
  }

  /**
   * @param {BlobId} blobId
   * @param {object} [options]
   * @param {boolean} [options.wait=false] Set to `true` to wait for a blob to download, otherwise will throw if blob is not available locally
   * @param {number} [options.timeout] Optional timeout to wait for a blob to download
   */
  createReadStream(
    { type, variant, name, driveId },
    options = { wait: false }
  ) {
    // TODO: Error thrown from this be an emit error on the returned stream?
    const drive = this.#getDrive(driveId)
    const path = makePath({ type, variant, name })

    // @ts-ignore - TODO: update @digidem/types to include wait/timeout options
    return drive.createReadStream(path, options)
  }

  /**
   * Optimization for creating the blobs read stream when you have
   * previously read the entry from Hyperdrive using `drive.entry`
   * @param {BlobId['driveId']} driveId Hyperdrive drive discovery id
   * @param {import('hyperdrive').HyperdriveEntry} entry Hyperdrive entry
   * @param {object} [options]
   * @param {boolean} [options.wait=false] Set to `true` to wait for a blob to download, otherwise will throw if blob is not available locally
   */
  async createEntryReadStream(driveId, entry, options = { wait: false }) {
    const drive = this.#getDrive(driveId)
    const blobs = await drive.getBlobs()

    if (!blobs) {
      throw new Error(
        'Hyperblobs instance not found for drive ' + driveId.slice(0, 7)
      )
    }

    return blobs.createReadStream(entry.value.blob, options)
  }

  /**
   * @param {BlobId['driveId']} driveId Hyperdrive drive id
   * @param {import('hyperdrive').HyperdriveEntry} entry Hyperdrive entry
   * @param {object} [opts]
   * @param {number} [opts.length]
   *
   * @returns {Promise<Buffer | null>}
   */
  async getEntryBlob(driveId, entry, { length } = {}) {
    const drive = this.#getDrive(driveId)
    const blobs = await drive.getBlobs()

    if (!blobs) {
      throw new Error(
        'Hyperblobs instance not found for drive ' + driveId.slice(0, 7)
      )
    }

    return blobs.get(entry.value.blob, { wait: false, start: 0, length })
  }

  /**
   *
   * @param {Omit<BlobId, 'driveId'>} blobId
   * @param {Buffer} blob
   * @param {object} [options]
   * @param {{mimeType: string}} [options.metadata] Metadata to store with the blob
   * @returns {Promise<string>} discovery key as hex string of hyperdrive where blob is stored
   */
  async put({ type, variant, name }, blob, options) {
    const path = makePath({ type, variant, name })
    await this.#writer.put(path, blob, options)
    return this.writerDriveId
  }

  /**
   * @param {Omit<BlobId, 'driveId'>} blobId
   * @param {object} [options]
   * @param {JsonObject} [options.metadata] Metadata to store with the blob
   */
  createWriteStream({ type, variant, name }, options) {
    const path = makePath({ type, variant, name })
    const stream = this.#writer.createWriteStream(path, options)
    return proxyProps(stream, {
      driveId: this.writerDriveId,
    })
  }

  /**
   * @param {BlobId} blobId
   * @param {object} [options]
   * @param {boolean} [options.follow=false] Set to `true` to follow symlinks (16 max or throws an error)
   * @param {false} [options.wait=false] Set to `true` to wait for a blob to download, otherwise will throw if blob is not available locally
   * @param {never} [options.timeout] Optional timeout to wait for a blob to download
   * @returns {Promise<import('hyperdrive').HyperdriveEntry | null>}
   */
  async entry(
    { type, variant, name, driveId },
    options = { follow: false, wait: false }
  ) {
    const drive = this.#hyperdrives.get(driveId)
    if (!drive) throw new Error('Drive not found ' + driveId.slice(0, 7))
    const path = makePath({ type, variant, name })
    const entry = await drive.entry(path, options)
    return entry
  }

  /**
   * @param {BlobId} blobId
   * @param {object} [options]
   * @param {boolean} [options.diff=false] Enable to return an object with a `block` property with number of bytes removed
   * @return {Promise<{ blocks: number } | null>}
   */
  async clear({ type, variant, name, driveId }, options = {}) {
    const path = makePath({ type, variant, name })
    const drive = this.#getDrive(driveId)

    return drive.clear(path, options)
  }
}

/**
 * @template {object} T
 * @template {object} U
 * @param {T} target
 * @param {U} props
 * @returns {T & U}
 */
function proxyProps(target, props) {
  // @ts-ignore - too much time to learn how to teach this to Typescript
  return new Proxy(target, {
    get(target, prop, receiver) {
      if (Object.hasOwn(props, prop)) {
        return Reflect.get(props, prop, receiver)
      } else {
        return Reflect.get(target, prop, receiver)
      }
    },
  })
}

/** @param {Pick<BlobId, 'type' | 'variant' | 'name'>} opts */
function makePath({ type, variant, name }) {
  return `/${type}/${variant}/${name}`
}

/**
 * Implements the `get()` method as used by hyperdrive-next. It returns the
 * relevant cores from the Mapeo CoreManager.
 */
class PretendCorestore {
  #coreManager
  /**
   * @param {object} options
   * @param {import('../core-manager/index.js').CoreManager} options.coreManager
   */
  constructor({ coreManager }) {
    this.#coreManager = coreManager
  }

  /**
   * @param {Buffer | { publicKey: Buffer } | { name: string }} opts
   * @returns {import('hypercore')<"binary", Buffer> | undefined}
   */
  get(opts) {
    if (b4a.isBuffer(opts)) {
      opts = { publicKey: opts }
    }
    if ('key' in opts) {
      // @ts-ignore
      opts.publicKey = opts.key
    }
    if ('publicKey' in opts) {
      // NB! We should always add blobIndex (Hyperbee) cores to the core manager
      // before we use them here. We would only reach the addCore path if the
      // blob core is read from the hyperbee header (before it is added to the
      // core manager)
      return (
        this.#coreManager.getCoreByKey(opts.publicKey) ||
        this.#coreManager.addCore(opts.publicKey, 'blob').core
      )
    } else if (opts.name === 'db') {
      return this.#coreManager.getWriterCore('blobIndex').core
    } else if (opts.name.includes('blobs')) {
      return this.#coreManager.getWriterCore('blob').core
    } else {
      throw new Error(
        'Unsupported corestore.get() with opts ' + util.inspect(opts)
      )
    }
  }

  /** no-op */
  close() {}
}

/**
 * @param {Buffer} key Public key of hypercore
 * @returns {string} Hex-encoded string of derived discovery key
 */
function getDiscoveryId(key) {
  return discoveryKey(key).toString('hex')
}
