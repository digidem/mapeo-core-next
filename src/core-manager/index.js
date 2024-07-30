import { TypedEmitter } from 'tiny-typed-emitter'
import Corestore from 'corestore'
import { debounce } from 'throttle-debounce'
import assert from 'node:assert/strict'
import { sql, eq } from 'drizzle-orm'
import { discoveryKey } from 'hypercore-crypto'
import Hypercore from 'hypercore'

import { HaveExtension, ProjectExtension } from '../generated/extensions.js'
import { Logger } from '../logger.js'
import { NAMESPACES } from '../constants.js'
import { ExhaustivenessError, keyToId, noop } from '../utils.js'
import { coresTable } from '../schema/project.js'
import * as rle from './bitfield-rle.js'
import { CoreIndex } from './core-index.js'

/** @typedef {import('../types.js').HypercorePeer} HypercorePeer */

const WRITER_CORE_PREHAVES_DEBOUNCE_DELAY = 1000

export const kCoreManagerReplicate = Symbol('replicate core manager')

/** @typedef {import('hypercore')<'binary', Buffer>} Core */
/** @typedef {(typeof NAMESPACES)[number]} Namespace */
/** @typedef {{ core: Core, key: Buffer, namespace: Namespace }} CoreRecord */
/** @typedef {import('streamx').Duplex} DuplexStream */
/**
 * @typedef {Object} Events
 * @property {(coreRecord: CoreRecord) => void} add-core
 * @property {(namespace: Namespace, msg: { coreDiscoveryId: string, peerId: string, start: number, bitfield: Uint32Array }) => void} peer-have
 */

/**
 * @extends {TypedEmitter<Events>}
 */
export class CoreManager extends TypedEmitter {
  #corestore
  #coreIndex
  /** @type {Core} */
  #creatorCore
  #projectKey
  #queries
  #getRole
  #encryptionKeys
  #projectExtension
  /** @type {'opened' | 'closing' | 'closed'} */
  #state = 'opened'
  #ready
  #haveExtension
  #deviceId
  #l
  /**
   * We use this to reduce network traffic caused by requesting the same key
   * from multiple clients.
   * TODO: Remove items from this set after a max age
   */
  #keyRequests = new TrackedKeyRequests()
  #autoDownload

  static get namespaces() {
    return NAMESPACES
  }

  /**
   * @param {Object} options
   * @param {import('drizzle-orm/better-sqlite3').BetterSQLite3Database} options.db Drizzle better-sqlite3 database instance
   * @param {import('@mapeo/crypto').KeyManager} options.keyManager mapeo/crypto KeyManager instance
   * @param {Buffer} options.projectKey 32-byte public key of the project creator core
   * @param {Buffer} [options.projectSecretKey] 32-byte secret key of the project creator core
   * @param {Partial<Record<Namespace, Buffer>>} [options.encryptionKeys] Encryption keys for each namespace
   * @param {import('hypercore').HypercoreStorage} options.storage Folder to store all hypercore data
   * @param {boolean} [options.autoDownload=true] Immediately start downloading cores - should only be set to false for tests
   * @param {typeof import('../roles.js').Roles.prototype.getRole} options.getRole
   * @param {Logger} [options.logger]
   */
  constructor({
    db,
    keyManager,
    projectKey,
    projectSecretKey,
    encryptionKeys = {},
    storage,
    autoDownload = true,
    getRole,
    logger,
  }) {
    super()
    assert(
      projectKey.length === 32,
      'project owner core public key must be 32-byte buffer'
    )
    assert(
      !projectSecretKey || projectSecretKey.length === 64,
      'project owner core secret key must be 64-byte buffer'
    )
    // Each peer will attach a listener, so max listeners is max attached peers
    this.setMaxListeners(0)
    this.#l = Logger.create('coreManager', logger)
    const primaryKey = keyManager.getDerivedKey('primaryKey', projectKey)
    this.#deviceId = keyManager.getIdentityKeypair().publicKey.toString('hex')
    this.#projectKey = projectKey
    this.#encryptionKeys = encryptionKeys
    this.#autoDownload = autoDownload
    this.#getRole = getRole

    // Pre-prepare SQL statement for better performance
    this.#queries = {
      addCore: db
        .insert(coresTable)
        .values({
          publicKey: sql.placeholder('publicKey'),
          namespace: sql.placeholder('namespace'),
        })
        .onConflictDoNothing()
        .prepare(),
      removeCores: db
        .delete(coresTable)
        .where(eq(coresTable.namespace, sql.placeholder('namespace')))
        .prepare(),
    }

    // Note: the primary key here should not be used, because we do not rely on
    // corestore for key storage (i.e. we do not get cores from corestore via a
    // name, which would derive the keypair from the primary key), but setting
    // this just in case a dependency does (e.g. hyperdrive) and we miss it.
    this.#corestore = new Corestore(storage, { primaryKey })
    // Persistent index of core keys and namespaces in the project
    this.#coreIndex = new CoreIndex()

    // Writer cores and root core, keys and namespaces are not persisted because
    // we derive the keys here.
    for (const namespace of NAMESPACES) {
      let keyPair
      if (namespace === 'auth' && projectSecretKey) {
        // For the project creator, the creatorCore is the same as the writer
        // core for the 'auth' namespace
        keyPair = { publicKey: projectKey, secretKey: projectSecretKey }
      } else {
        // Deterministic keypair, based on rootKey, namespace & projectKey
        keyPair = keyManager.getHypercoreKeypair(namespace, projectKey)
      }
      const writer = this.#addCore(keyPair, namespace)
      if (namespace === 'auth' && projectSecretKey) {
        this.#creatorCore = writer.core
      }
    }

    // For anyone other than the project creator, creatorCore is readonly
    this.#creatorCore ??= this.#addCore({ publicKey: projectKey }, 'auth').core

    // Load persisted cores
    const rows = db.select().from(coresTable).all()
    for (const { publicKey, namespace } of rows) {
      this.#addCore({ publicKey }, namespace)
    }

    this.#projectExtension = this.#creatorCore.registerExtension(
      'mapeo/project',
      {
        encoding: ProjectExtensionCodec,
        onmessage: (msg, peer) => {
          this.#handleProjectMessage(msg, peer).catch(noop)
        },
      }
    )

    this.#haveExtension = this.#creatorCore.registerExtension('mapeo/have', {
      encoding: HaveExtensionCodec,
      onmessage: (msg, peer) => {
        this.#handleHaveMessage(msg, peer)
      },
    })

    this.#creatorCore.on('peer-add', (peer) => {
      this.#sendHaves(peer, this.#coreIndex).catch(() => {
        this.#l.log('Failed to send pre-haves to newly-connected peer')
      })
    })
    this.#creatorCore.on('peer-remove', (peer) => {
      // When a peer is removed we clean up any unanswered key requests, so that
      // we will request from a different peer, and to avoid the tracking of key
      // requests growing without bounds.
      this.#keyRequests.deleteByPeerKey(peer.remotePublicKey)
    })

    this.#ready = Promise.all(
      [...this.#coreIndex].map(({ core }) => core.ready())
    )
      .then(() => {
        this.#l.log('ready')
      })
      .catch(() => {})
  }

  get deviceId() {
    return this.#deviceId
  }

  get creatorCore() {
    return this.#creatorCore
  }

  /**
   * Resolves when all cores have finished loading
   *
   * @returns {Promise<void>}
   */
  async ready() {
    await this.#ready
  }

  /**
   * Get the writer core for the given namespace
   *
   * @param {Namespace} namespace
   */
  getWriterCore(namespace) {
    return this.#coreIndex.getWriter(namespace)
  }

  /**
   * Get an array of all cores in the given namespace
   *
   * @param {Namespace} namespace
   */
  getCores(namespace) {
    return this.#coreIndex.getByNamespace(namespace)
  }

  /**
   * Get a core by its public key
   *
   * @param {Buffer} key
   * @returns {Core | undefined}
   */
  getCoreByKey(key) {
    const coreRecord = this.#coreIndex.getByCoreKey(key)
    return coreRecord && coreRecord.core
  }

  /**
   * Get a core by its discovery key
   *
   * @param {Buffer} discoveryKey
   * @returns {CoreRecord | undefined}
   */
  getCoreByDiscoveryKey(discoveryKey) {
    const coreRecord = this.#coreIndex.getByDiscoveryId(
      discoveryKey.toString('hex')
    )
    return coreRecord
  }

  /**
   * Close all open cores and end any replication streams
   * TODO: gracefully close replication streams
   */
  async close() {
    this.#state = 'closing'
    this.#keyRequests.clear()
    const promises = []
    for (const { core } of this.#coreIndex) {
      promises.push(core.close())
    }
    await Promise.all(promises)
    this.#state = 'closed'
  }

  /**
   * Add a core to the manager (will be persisted across restarts)
   *
   * @param {Buffer} key 32-byte public key of core to add
   * @param {Namespace} namespace
   * @returns {import('./core-index.js').CoreRecord}
   */
  addCore(key, namespace) {
    return this.#addCore({ publicKey: key }, namespace, true)
  }

  /**
   * Add a core to the manager (writer cores and project creator core not persisted)
   *
   * @param {{ publicKey: Buffer, secretKey?: Buffer }} keyPair
   * @param {Namespace} namespace
   * @param {boolean} [persist=false]
   * @returns {import('./core-index.js').CoreRecord}
   */
  #addCore(keyPair, namespace, persist = false) {
    // No-op if core is already managed
    const existingCore = this.#coreIndex.getByCoreKey(keyPair.publicKey)
    if (existingCore) return existingCore

    const { publicKey: key, secretKey } = keyPair
    const writer = !!secretKey
    const core = this.#corestore.get({
      keyPair,
      encryptionKey: this.#encryptionKeys[namespace],
    })
    if (this.#autoDownload) {
      core.download({ start: 0, end: -1 })
    }
    // Every peer adds a listener, so could have many peers
    core.setMaxListeners(0)
    // @ts-ignore - ensure key is defined before hypercore is ready
    core.key = key
    this.#coreIndex.add({ core, key, namespace, writer })

    // **Hack** As soon as a peer is added, eagerly send a "want" for the entire
    // core. This ensures that the peer sends back its entire bitfield.
    // Otherwise this would only happen once we call core.download()
    core.on('peer-add', (peer) => {
      if (core.length === 0) return
      // **Warning** uses internal method, but should be covered by tests
      peer._maybeWant(0, core.length)
    })

    if (writer) {
      const sendHaves = debounce(WRITER_CORE_PREHAVES_DEBOUNCE_DELAY, () => {
        for (const peer of this.#creatorCore.peers) {
          this.#sendHaves(peer, [{ core, namespace }]).catch(() => {
            this.#l.log('Failed to send new pre-haves to other peers')
          })
        }
      })

      // Tell connected peers, who we aren't necessarily syncing with, about
      // what we just added or cleared. Hypercore doesn't emit anything when
      // clearing, so we patch it in.
      core.on('append', sendHaves)
      const originalClear = core.clear
      core.clear = function clear() {
        const result = originalClear.apply(this, /** @type {any} */ (arguments))
        result.then(sendHaves).catch(noop)
        return result
      }
    } else {
      // A non-writer core will emit 'append' when its length is updated from
      // the initial sync with a peer, and we will not have sent a "maybe want"
      // for this range, so we need to do it now. Subsequent appends are
      // propagated (more efficiently) via range broadcasts, so we only need to
      // listen to the first append.
      core.once('append', () => {
        for (const peer of core.peers) {
          // TODO: It would be more efficient (in terms of network traffic) to
          // send a want with start = length of previous want. Need to track
          // "last want length" sent by peer.
          peer._maybeWant(0, core.length)
        }
      })
    }

    if (persist) {
      this.#queries.addCore.run({ publicKey: key, namespace })
    }

    this.#l.log(
      'Added %s %s core %k',
      persist ? 'remote' : writer ? 'local' : 'creator',
      namespace,
      key
    )
    this.emit('add-core', { core, key, namespace })

    return { core, key, namespace }
  }

  /**
   * Send an extension message over the project creator core replication stream
   * requesting a core key for the given discovery key.
   *
   * @param {Buffer} peerKey
   * @param {Buffer} discoveryKey
   */
  requestCoreKey(peerKey, discoveryKey) {
    // No-op if we already have this core
    if (this.getCoreByDiscoveryKey(discoveryKey)) return
    const peer = this.#creatorCore.peers.find((peer) => {
      return peer.remotePublicKey.equals(peerKey)
    })
    if (!peer) {
      // This should not happen because this is only called from SyncApi, which
      // checks the peer exists before calling this method.
      this.#l.log(
        'Attempted to request core key for %h, but no connected peer %h',
        discoveryKey,
        peerKey
      )
      return
    }
    // Only request a key once, e.g. from the peer we first receive it from (we
    // can assume that a peer must have the key if we see the discovery key in
    // the protomux). This is necessary to reduce network traffic for many newly
    // connected peers - otherwise duplicate requests will be sent to every peer
    if (this.#keyRequests.has(discoveryKey)) return
    this.#keyRequests.set(discoveryKey, peerKey)

    this.#l.log(
      'Requesting core key for discovery key %h from peer %h',
      discoveryKey,
      peerKey
    )
    const message = ProjectExtension.fromPartial({
      wantCoreKeys: [discoveryKey],
    })
    this.#projectExtension.send(message, peer)
  }

  /**
   * @param {ProjectExtension} msg
   * @param {HypercorePeer} peer
   * @returns {Promise<void>}
   */
  async #handleProjectMessage({ wantCoreKeys, ...coreKeys }, peer) {
    const message = ProjectExtension.create()
    let hasKeys = false
    for (const discoveryKey of wantCoreKeys) {
      const coreRecord = this.getCoreByDiscoveryKey(discoveryKey)
      if (!coreRecord) continue
      message[`${coreRecord.namespace}CoreKeys`].push(coreRecord.key)
      hasKeys = true
    }
    if (hasKeys) {
      this.#projectExtension.send(message, peer)
    }

    const syncCapabilities = await this.#getSyncCapabilities(peer)

    for (const namespace of NAMESPACES) {
      if (!canSync(syncCapabilities, namespace)) continue
      for (const coreKey of coreKeys[`${namespace}CoreKeys`]) {
        // Use public method - these must be persisted (private method defaults to persisted=false)
        this.addCore(coreKey, namespace)
        this.#keyRequests.deleteByDiscoveryKey(discoveryKey(coreKey))
      }
    }
  }

  // TODO: Move this elsewhere
  /**
   * @param {HypercorePeer} peer
   */
  async #getSyncCapabilities(peer) {
    const peerDeviceId = keyToId(peer.remotePublicKey)
    const role = await this.#getRole(peerDeviceId, { timeout: 10_000 })
    return role.sync
  }

  /**
   * @param {Omit<HaveMsg, 'namespace'> & { namespace: Namespace | 'UNRECOGNIZED' }} msg
   * @param {HypercorePeer} peer
   */
  #handleHaveMessage(msg, peer) {
    const { start, discoveryKey, bitfield, namespace } = msg
    if (namespace === 'UNRECOGNIZED') return
    /** @type {string} */
    const peerId = peer.remotePublicKey.toString('hex')
    const coreDiscoveryId = discoveryKey.toString('hex')
    this.emit('peer-have', namespace, {
      coreDiscoveryId,
      peerId,
      start,
      bitfield,
    })
  }

  /**
   *
   * @param {HypercorePeer} peer
   * @param {Iterable<{ core: Hypercore<Hypercore.ValueEncoding, Buffer>, namespace: Namespace }>} cores
   */
  async #sendHaves(peer, cores) {
    if (!peer) {
      console.error('Called #sendHaves with no peer')
      // TODO: How to handle this and when does it happen?
      return
    }

    peer.protomux.cork()

    for (const { core, namespace } of cores) {
      // We want ready() rather than update() because we are only interested in local data
      await core.ready()
      const { discoveryKey } = core
      // This will always be defined after ready(), but need to let TS know
      if (!discoveryKey) continue
      /** @type {Iterable<{ start: number, bitfield: Uint32Array }>} */
      // @ts-ignore - accessing internal property
      const bitfieldIterator = core.core.bitfield.want(0, core.length)
      for (const { start, bitfield } of bitfieldIterator) {
        const message = { start, bitfield, discoveryKey, namespace }
        this.#haveExtension.send(message, peer)
      }
    }

    peer.protomux.uncork()
  }

  /**
   * ONLY FOR TESTING
   * Replicate all cores in core manager
   *
   * @param {Parameters<Corestore['replicate']>[0]} stream
   * @returns
   */
  [kCoreManagerReplicate](stream) {
    const protocolStream = Hypercore.createProtocolStream(stream, {
      ondiscoverykey: async (discoveryKey) => {
        const peer = await findPeer(
          this.creatorCore,
          // @ts-ignore
          protocolStream.noiseStream.remotePublicKey
        )
        if (!peer) return
        this.requestCoreKey(peer.remotePublicKey, discoveryKey)
      },
    })
    return this.#corestore.replicate(stream)
  }

  /**
   * @param {Exclude<typeof NAMESPACES[number], 'auth'>} namespace
   * @returns {Promise<void>}
   */
  async deleteOthersData(namespace) {
    const coreRecords = this.getCores(namespace)
    const ownWriterCore = this.getWriterCore(namespace)

    const deletionPromises = []

    for (const { core, key } of coreRecords) {
      if (key.equals(ownWriterCore.key)) continue
      deletionPromises.push(core.purge())
    }

    await Promise.all(deletionPromises)

    this.#queries.removeCores.run({ namespace })
  }
}

/**
 * @typedef {object} HaveMsg
 * @property {Buffer} discoveryKey
 * @property {number} start
 * @property {Uint32Array} bitfield
 * @property {Namespace} namespace
 */

const ProjectExtensionCodec = {
  /** @param {Parameters<typeof ProjectExtension.encode>[0]} msg */
  encode(msg) {
    return ProjectExtension.encode(msg).finish()
  },
  /** @param {Buffer | Uint8Array} buf */
  decode(buf) {
    return ProjectExtension.decode(buf)
  },
}

const HaveExtensionCodec = {
  /** @param {HaveMsg} msg */
  encode({ start, discoveryKey, bitfield, namespace }) {
    const encodedBitfield = rle.encode(bitfield)
    const msg = { start, discoveryKey, encodedBitfield, namespace }
    return HaveExtension.encode(msg).finish()
  },
  /**
   * @param {Buffer | Uint8Array} buf
   * @returns {Omit<HaveMsg, 'namespace'> & { namespace: HaveMsg['namespace'] | 'UNRECOGNIZED' }}
   */
  decode(buf) {
    const { start, discoveryKey, encodedBitfield, namespace } =
      HaveExtension.decode(buf)
    try {
      const bitfield = rle.decode(encodedBitfield)
      return { start, discoveryKey, bitfield, namespace }
    } catch (e) {
      // TODO: Log error
      console.error(e)
      return { start, discoveryKey, bitfield: new Uint32Array(), namespace }
    }
  },
}

class TrackedKeyRequests {
  /** @type {Map<string, string>} */
  #byDiscoveryId = new Map()
  /** @type {Map<string, Set<string>>} */
  #byPeerId = new Map()

  /**
   * @param {Buffer} discoveryKey
   * @param {Buffer} peerKey
   */
  set(discoveryKey, peerKey) {
    const discoveryId = keyToId(discoveryKey)
    const peerId = keyToId(peerKey)
    const existingForPeer = this.#byPeerId.get(peerId) || new Set()
    this.#byDiscoveryId.set(discoveryId, peerId)
    existingForPeer.add(discoveryId)
    this.#byPeerId.set(peerId, existingForPeer)
    return this
  }
  /**
   * @param {Buffer} discoveryKey
   */
  has(discoveryKey) {
    const discoveryId = keyToId(discoveryKey)
    return this.#byDiscoveryId.has(discoveryId)
  }
  /**
   * @param {Buffer} discoveryKey
   */
  deleteByDiscoveryKey(discoveryKey) {
    const discoveryId = keyToId(discoveryKey)
    const peerId = this.#byDiscoveryId.get(discoveryId)
    if (!peerId) return false
    this.#byDiscoveryId.delete(discoveryId)
    const existingForPeer = this.#byPeerId.get(peerId)
    if (existingForPeer) {
      existingForPeer.delete(discoveryId)
    }
    return true
  }
  /**
   * @param {Buffer} peerKey
   */
  deleteByPeerKey(peerKey) {
    const peerId = keyToId(peerKey)
    const existingForPeer = this.#byPeerId.get(peerId)
    if (!existingForPeer) return
    for (const discoveryId of existingForPeer) {
      this.#byDiscoveryId.delete(discoveryId)
    }
    this.#byPeerId.delete(peerId)
  }
  clear() {
    this.#byDiscoveryId.clear()
    this.#byPeerId.clear()
  }
}

/**
 * @param {Hypercore<"binary", Buffer>} core
 * @param {Buffer} publicKey
 * @param {{ timeout?: number }} [opts]
 */
function findPeer(core, publicKey, { timeout = 200 } = {}) {
  const peer = core.peers.find((peer) => {
    return peer.remotePublicKey.equals(publicKey)
  })
  if (peer) return peer
  // This is called from the from the handleDiscoveryId event, which can
  // happen before the peer connection is fully established, so we wait for
  // the `peer-add` event, with a timeout in case the peer never gets added
  return new Promise(function (res) {
    const timeoutId = setTimeout(function () {
      core.off('peer-add', onPeer)
      res(null)
    }, timeout)

    core.on('peer-add', onPeer)

    /** @param {HypercorePeer} peer */
    function onPeer(peer) {
      if (peer.remotePublicKey.equals(publicKey)) {
        clearTimeout(timeoutId)
        core.off('peer-add', onPeer)
        res(peer)
      }
    }
  })
}

/**
 * @param {Record<Namespace, 'allowed' | 'blocked'>} syncCapabilities
 * @param {Namespace} namespace
 * @returns {boolean}
 */
function canSync(syncCapabilities, namespace) {
  const syncCapability = syncCapabilities[namespace]
  switch (syncCapability) {
    case 'allowed':
      return true
    case 'blocked':
      return false
    default:
      throw new ExhaustivenessError(syncCapability)
  }
}
