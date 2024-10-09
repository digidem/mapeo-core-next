import mapObject from 'map-obj'
import { NAMESPACES, PRESYNC_NAMESPACES } from '../constants.js'
import { Logger } from '../logger.js'
import { ExhaustivenessError, createMap } from '../utils.js'
import { unreplicate } from '../lib/hypercore-helpers.js'
/** @import { CoreRecord } from '../core-manager/index.js' */
/** @import { Role } from '../roles.js' */
/** @import { SyncEnabledState } from './sync-api.js' */
/** @import { Namespace } from '../types.js' */
/** @import { OpenedNoiseStream } from '../lib/noise-secret-stream-helpers.js' */

/**
 * @typedef {Role['sync'][Namespace] | 'unknown'} SyncCapability
 */

export class PeerSyncController {
  #replicatingCores = new Set()
  /** @type {Set<Namespace>} */
  #enabledNamespaces = new Set()
  #coreManager
  #protomux
  #roles
  /** @type {Record<Namespace, SyncCapability>} */
  #syncCapability = createNamespaceMap('unknown')
  /** @type {SyncEnabledState} */
  #syncEnabledState = 'none'
  /** @type {Record<Namespace, import('./core-sync-state.js').LocalCoreState | null>} */
  #prevLocalState = createNamespaceMap(null)
  /** @type {SyncStatus} */
  #syncStatus = createNamespaceMap('unknown')
  /** @type {Map<import('hypercore')<'binary', any>, ReturnType<import('hypercore')['download']>>} */
  #downloadingRanges = new Map()
  /** @type {SyncStatus} */
  #prevSyncStatus = createNamespaceMap('unknown')
  /** @type {import('debug').Debugger} */
  #log

  /**
   * @param {object} opts
   * @param {import('protomux')<OpenedNoiseStream>} opts.protomux
   * @param {import("../core-manager/index.js").CoreManager} opts.coreManager
   * @param {import("./sync-state.js").SyncState} opts.syncState
   * @param {import('../roles.js').Roles} opts.roles
   * @param {Logger} [opts.logger]
   */
  constructor({ protomux, coreManager, syncState, roles, logger }) {
    const logPrefix = `[${protomux.stream.remotePublicKey
      ?.toString('hex')
      .slice(0, 7)}] `
    this.#log = Logger.create('peer', logger, { prefix: logPrefix }).log
    this.#coreManager = coreManager
    this.#protomux = protomux
    this.#roles = roles

    // Always need to replicate the project creator core
    this.#replicateCoreRecord(coreManager.creatorCoreRecord)

    coreManager.on('add-core', this.#handleAddCore)
    syncState.on('state', this.#handleStateChange)

    this.#updateEnabledNamespaces()
  }

  get peerKey() {
    return this.#protomux.stream.remotePublicKey
  }

  get peerId() {
    return this.peerKey.toString('hex')
  }

  get syncCapability() {
    return this.#syncCapability
  }

  /** @param {SyncEnabledState} syncEnabledState */
  setSyncEnabledState(syncEnabledState) {
    if (this.#syncEnabledState === syncEnabledState) {
      return
    }
    this.#syncEnabledState = syncEnabledState
    this.#updateEnabledNamespaces()
  }

  /**
   * @param {Buffer} discoveryKey
   */
  handleDiscoveryKey(discoveryKey) {
    const coreRecord = this.#coreManager.getCoreByDiscoveryKey(discoveryKey)
    // If we already know about this core, then we will add it to the
    // replication stream when we are ready
    if (coreRecord) {
      if (this.#enabledNamespaces.has(coreRecord.namespace)) {
        this.#replicateCoreRecord(coreRecord)
      } else {
        this.#log(
          'Received discovery key %h, for core %h, but namespace %s is disabled',
          discoveryKey,
          coreRecord.key,
          coreRecord.namespace
        )
      }
    } else {
      this.#log('Received unknown discovery key %h', discoveryKey)
    }
  }

  /**
   * Handler for 'core-add' event from CoreManager
   * Bound to `this` (defined as static property)
   *
   * @param {CoreRecord} coreRecord
   */
  #handleAddCore = (coreRecord) => {
    if (!this.#enabledNamespaces.has(coreRecord.namespace)) return
    this.#replicateCoreRecord(coreRecord)
  }

  /**
   * Handler for 'state' event from SyncState
   * Bound to `this` (defined as static property)
   *
   * @param {import("./sync-state.js").State} state
   */
  #handleStateChange = async (state) => {
    // The remotePublicKey is only available after the noise stream has
    // connected. We shouldn't get a state change before the noise stream has
    // connected, but if we do we can ignore it because we won't have any useful
    // information until it connects.
    if (!this.peerId) return
    this.#syncStatus = getSyncStatus(this.peerId, state)
    const localState = mapObject(state, (ns, nsState) => {
      return [ns, nsState.localState]
    })
    this.#log('state %X', state)

    // Map of which namespaces have received new data since last sync change
    const didUpdate = mapObject(state, (ns) => {
      const nsDidSync =
        this.#prevSyncStatus[ns] !== 'synced' &&
        this.#syncStatus[ns] === 'synced'
      const prevNsState = this.#prevLocalState[ns]
      const nsDidUpdate =
        nsDidSync &&
        (prevNsState === null || prevNsState.have !== localState[ns].have)
      if (nsDidUpdate) {
        this.#prevLocalState[ns] = localState[ns]
      }
      return [ns, nsDidUpdate]
    })
    this.#prevSyncStatus = this.#syncStatus

    if (didUpdate.auth) {
      try {
        this.#log('reading role for %h', this.peerId)
        const cap = await this.#roles.getRole(this.peerId)
        this.#syncCapability = cap.sync
      } catch (e) {
        this.#log('Error reading role', e)
        // Any error, consider sync unknown
        this.#syncCapability = createNamespaceMap('unknown')
      }
    }
    this.#log('capability %o', this.#syncCapability)

    this.#updateEnabledNamespaces()
  }

  /**
   * Enable and disable the appropriate namespaces.
   *
   * If replicating no namespace groups, all namespaces are disabled.
   *
   * If only replicating the initial namespace groups, only the initial
   * namespaces are replicated, assuming the capability permits.
   *
   * If replicating all namespaces, everything is replicated. However, data
   * namespaces are only enabled after the initial namespaces have synced. And
   * again, capabilities are checked.
   */
  #updateEnabledNamespaces() {
    /** @type {boolean} */ let isAnySyncEnabled
    /** @type {boolean} */ let isDataSyncEnabled
    switch (this.#syncEnabledState) {
      case 'none':
        isAnySyncEnabled = isDataSyncEnabled = false
        break
      case 'presync':
        isAnySyncEnabled = true
        isDataSyncEnabled = false
        break
      case 'all':
        isAnySyncEnabled = isDataSyncEnabled = true
        break
      default:
        throw new ExhaustivenessError(this.#syncEnabledState)
    }

    for (const ns of NAMESPACES) {
      if (!isAnySyncEnabled) {
        this.#disableNamespace(ns)
        continue
      }

      const cap = this.#syncCapability[ns]
      if (cap === 'blocked') {
        this.#disableNamespace(ns)
      } else if (cap === 'unknown') {
        if (ns === 'auth') {
          this.#enableNamespace(ns)
        } else {
          this.#disableNamespace(ns)
        }
      } else if (cap === 'allowed') {
        if (PRESYNC_NAMESPACES.includes(ns)) {
          this.#enableNamespace(ns)
        } else if (isDataSyncEnabled) {
          const arePresyncNamespacesSynced = PRESYNC_NAMESPACES.every(
            (ns) => this.#syncStatus[ns] === 'synced'
          )
          // Only enable data namespaces once the pre-sync namespaces have synced
          if (arePresyncNamespacesSynced) {
            this.#enableNamespace(ns)
          }
        } else {
          this.#disableNamespace(ns)
        }
      } else {
        throw new ExhaustivenessError(cap)
      }
    }
  }

  /**
   * @param {CoreRecord} coreRecord
   */
  #replicateCoreRecord({ core, namespace }) {
    if (core.closed) return
    if (this.#replicatingCores.has(core)) return
    this.#log('replicating %s core %k', namespace, core.key)
    core.replicate(this.#protomux)
    this.#replicatingCores.add(core)

    if (!this.#log.enabled) return

    /** @type {(peer: any) => void} */
    const handlePeerRemove = (peer) => {
      if (!peer.remotePublicKey.equals(this.peerKey)) return
      core.off('peer-remove', handlePeerRemove)
      this.#log(
        'peer-remove %h from %s core %k',
        peer.remotePublicKey,
        namespace,
        core.key
      )
    }
    core.on('peer-remove', handlePeerRemove)
  }

  /**
   * @param {CoreRecord} coreRecord
   * @returns {Promise<void>}
   */
  async #unreplicateCoreRecord({ core, namespace }) {
    if (core === this.#coreManager.creatorCore) return

    this.#replicatingCores.delete(core)

    const isCoreReady = Boolean(core.discoveryKey)
    if (!isCoreReady) {
      await core.ready()
      const wasReEnabledWhileWaiting = this.#replicatingCores.has(core)
      if (wasReEnabledWhileWaiting) return
    }

    unreplicate(core, this.#protomux)
    this.#log('unreplicated %s core %k', namespace, core.key)
  }

  /**
   * @param {Namespace} namespace
   */
  #enableNamespace(namespace) {
    if (this.#enabledNamespaces.has(namespace)) return
    for (const coreRecord of this.#coreManager.getCores(namespace)) {
      this.#replicateCoreRecord(coreRecord)
    }
    this.#enabledNamespaces.add(namespace)
    this.#log('enabled namespace %s', namespace)
  }

  /**
   * @param {Namespace} namespace
   */
  #disableNamespace(namespace) {
    if (!this.#enabledNamespaces.has(namespace)) return
    for (const coreRecord of this.#coreManager.getCores(namespace)) {
      this.#unreplicateCoreRecord(coreRecord)
    }
    this.#enabledNamespaces.delete(namespace)
    this.#log('disabled namespace %s', namespace)
  }
}

/**
 * @typedef {{ [namespace in Namespace]?: import("./core-sync-state.js").PeerNamespaceState }} PeerState
 */

/** @typedef {Record<Namespace, 'unknown' | 'syncing' | 'synced'>} SyncStatus */

/**
 * @param {string} peerId
 * @param {import('./sync-state.js').State} state
 * @returns {SyncStatus}
 */
function getSyncStatus(peerId, state) {
  const syncStatus = /** @type {SyncStatus} */ ({})
  for (const namespace of NAMESPACES) {
    const peerState = state[namespace].remoteStates[peerId]
    if (!peerState) {
      syncStatus[namespace] = 'unknown'
    } else if (
      peerState.status === 'started' &&
      state[namespace].localState.want === 0
    ) {
      syncStatus[namespace] = 'synced'
    } else {
      syncStatus[namespace] = 'syncing'
    }
  }
  return syncStatus
}

/**
 * @template T
 * @param {T} value
 **/
function createNamespaceMap(value) {
  return createMap(NAMESPACES, value)
}
