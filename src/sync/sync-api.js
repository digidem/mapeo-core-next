import { TypedEmitter } from 'tiny-typed-emitter'
import WebSocket from 'ws'
import { SyncState } from './sync-state.js'
import { PeerSyncController } from './peer-sync-controller.js'
import { Logger } from '../logger.js'
import {
  DATA_NAMESPACES,
  NAMESPACES,
  PRESYNC_NAMESPACES,
} from '../constants.js'
import { ExhaustivenessError, assert, keyToId, noop } from '../utils.js'
import { getOwn } from '../lib/get-own.js'
import { NO_ROLE_ID } from '../roles.js'
import { wsCoreReplicator } from '../server/ws-core-replicator.js'
/** @import { CoreOwnership as CoreOwnershipDoc } from '@comapeo/schema' */
/** @import { CoreOwnership } from '../core-ownership.js' */
/** @import { OpenedNoiseStream } from '../lib/noise-secret-stream-helpers.js' */
/** @import { ReplicationStream } from '../types.js' */

export const kHandleDiscoveryKey = Symbol('handle discovery key')
export const kSyncState = Symbol('sync state')
export const kRequestFullStop = Symbol('background')
export const kRescindFullStopRequest = Symbol('foreground')
export const kWaitForInitialSyncWithPeer = Symbol(
  'wait for initial sync with peer'
)

/**
 * @typedef {'initial' | 'full'} SyncType
 */

/**
 * @typedef {'none' | 'presync' | 'all'} SyncEnabledState
 */

/**
 * @internal
 * @typedef {object} RemoteDeviceNamespaceGroupSyncState
 * @property {boolean} isSyncEnabled do we want to sync this namespace group?
 * @property {number} want number of blocks this device wants from us
 * @property {number} wanted number of blocks we want from this device
 */

/**
 * @internal
 * @typedef {object} RemoteDeviceSyncState state of sync for a remote peer
 * @property {RemoteDeviceNamespaceGroupSyncState} initial state of initial namespaces (auth, config, and blob index)
 * @property {RemoteDeviceNamespaceGroupSyncState} data state of data namespaces (data and blob)
 */

/**
 * @typedef {object} State
 * @property {{ isSyncEnabled: boolean }} initial state of initial namespace syncing (auth, config, and blob index) for local device
 * @property {{ isSyncEnabled: boolean }} data state of data namespace syncing (data and blob) for local device
 * @property {Record<string, RemoteDeviceSyncState>} remoteDeviceSyncState sync states for remote peers
 */

/**
 * @typedef {object} SyncEvents
 * @property {(syncState: State) => void} sync-state
 */

/**
 * @extends {TypedEmitter<SyncEvents>}
 */
export class SyncApi extends TypedEmitter {
  #coreManager
  #coreOwnership
  #roles
  /** @type {Map<import('protomux'), PeerSyncController>} */
  #peerSyncControllers = new Map()
  /** @type {Map<string, PeerSyncController>} */
  #pscByPeerId = new Map()
  #wantsToSyncData = false
  #hasRequestedFullStop = false
  /** @type {SyncEnabledState} */
  #previousSyncEnabledState = 'none'
  /** @type {null | number} */
  #previousDataHave = null
  /** @type {null | number} */
  #autostopDataSyncAfter = null
  /** @type {null | ReturnType<typeof setTimeout>} */
  #autostopDataSyncTimeout = null
  /** @type {Map<import('protomux'), Set<Buffer>>} */
  #pendingDiscoveryKeys = new Map()
  #l
  #getServerWebsocketUrls
  #getReplicationStream
  /** @type {Map<string, WebSocket>} */
  #serverWebsockets = new Map()

  /**
   * @param {object} opts
   * @param {import('../core-manager/index.js').CoreManager} opts.coreManager
   * @param {CoreOwnership} opts.coreOwnership
   * @param {import('../roles.js').Roles} opts.roles
   * @param {() => Promise<Iterable<string>>} opts.getServerWebsocketUrls
   * @param {() => ReplicationStream} opts.getReplicationStream
   * @param {number} [opts.throttleMs]
   * @param {Logger} [opts.logger]
   */
  constructor({
    coreManager,
    throttleMs = 200,
    roles,
    getServerWebsocketUrls,
    getReplicationStream,
    logger,
    coreOwnership,
  }) {
    super()
    this.#l = Logger.create('syncApi', logger)
    this.#coreManager = coreManager
    this.#coreOwnership = coreOwnership
    this.#roles = roles
    this.#getServerWebsocketUrls = getServerWebsocketUrls
    this.#getReplicationStream = getReplicationStream
    this[kSyncState] = new SyncState({
      coreManager,
      throttleMs,
      peerSyncControllers: this.#pscByPeerId,
      logger,
    })
    this[kSyncState].setMaxListeners(0)
    this[kSyncState].on('state', (namespaceSyncState) => {
      this.#updateState(namespaceSyncState)
    })

    this.#coreManager.creatorCore.on('peer-add', this.#handlePeerAdd)
    this.#coreManager.creatorCore.on('peer-remove', this.#handlePeerDisconnect)

    roles.on('update', this.#handleRoleUpdate)
    coreOwnership.on('update', this.#handleCoreOwnershipUpdate)

    this.#coreOwnership
      .getAll()
      .then((coreOwnerships) =>
        Promise.allSettled(
          coreOwnerships.map(async (coreOwnership) => {
            if (coreOwnership.docId === this.#coreManager.deviceId) return
            await this.#validateRoleAndAddCoresForPeer(coreOwnership)
          })
        )
      )
      .catch(noop)
  }

  /** @type {import('../local-peers.js').LocalPeersEvents['discovery-key']} */
  [kHandleDiscoveryKey](discoveryKey, protomux) {
    const peerSyncController = this.#peerSyncControllers.get(protomux)
    if (peerSyncController) {
      peerSyncController.handleDiscoveryKey(discoveryKey)
      return
    }
    // We will reach here if we are not part of the project, so we can ignore
    // these keys. However it's also possible to reach here when we are part of
    // a project, but the creator core `peer-add` event has not yet fired, so we
    // queue this to be handled in `#handlePeerAdd`
    const peerQueue = this.#pendingDiscoveryKeys.get(protomux) || new Set()
    peerQueue.add(discoveryKey)
    this.#pendingDiscoveryKeys.set(protomux, peerQueue)

    // If we _are_ part of the project, the `peer-add` should happen very soon
    // after we get a discovery-key event, so we cleanup our queue to avoid
    // memory leaks for any discovery keys that have not been handled.
    setTimeout(() => {
      const peerQueue = this.#pendingDiscoveryKeys.get(protomux)
      if (!peerQueue) return
      peerQueue.delete(discoveryKey)
      if (peerQueue.size === 0) {
        this.#pendingDiscoveryKeys.delete(protomux)
      }
    }, 500)
  }

  /**
   * Get the current sync state (initial and full). Also emitted via the 'sync-state' event
   * @returns {State}
   */
  getState() {
    return this.#getState(this[kSyncState].getState())
  }

  /**
   * @param {import('./sync-state.js').State} namespaceSyncState
   * @returns {State}
   */
  #getState(namespaceSyncState) {
    const remoteDeviceSyncState = getRemoteDevicesSyncState(
      namespaceSyncState,
      this.#peerSyncControllers.values()
    )

    switch (this.#previousSyncEnabledState) {
      case 'none':
        return {
          initial: { isSyncEnabled: false },
          data: { isSyncEnabled: false },
          remoteDeviceSyncState,
        }
      case 'presync':
        return {
          initial: { isSyncEnabled: true },
          data: { isSyncEnabled: false },
          remoteDeviceSyncState,
        }
      case 'all':
        return {
          initial: { isSyncEnabled: true },
          data: { isSyncEnabled: true },
          remoteDeviceSyncState,
        }
      default:
        throw new ExhaustivenessError(this.#previousSyncEnabledState)
    }
  }

  /**
   * Update which namespaces are synced and the autostop timeout.
   *
   * The following table describes the expected behavior based on inputs.
   *
   * | Want to sync data? | Full stop requested? | Synced? | Enabled | Timeout |
   * |--------------------|----------------------|---------|---------|---------|
   * | no                 | no                   | no      | presync | off     |
   * | no                 | no                   | yes     | presync | off     |
   * | no                 | yes                  | no      | presync | off     |
   * | no                 | yes                  | yes     | none    | off     |
   * | yes                | no                   | no      | all     | off     |
   * | yes                | no                   | yes     | all     | on      |
   * | yes                | yes                  | no      | all     | off     |
   * | yes                | yes                  | yes     | none    | off     |
   */
  #updateState(namespaceSyncState = this[kSyncState].getState()) {
    const dataHave = DATA_NAMESPACES.reduce(
      (total, namespace) =>
        total + namespaceSyncState[namespace].localState.have,
      0
    )
    const hasReceivedNewData = dataHave !== this.#previousDataHave
    if (hasReceivedNewData) {
      this.#clearAutostopDataSyncTimeoutIfExists()
    }
    this.#previousDataHave = dataHave

    /** @type {SyncEnabledState} */ let syncEnabledState
    if (this.#hasRequestedFullStop) {
      this.#clearAutostopDataSyncTimeoutIfExists()
      if (this.#previousSyncEnabledState === 'none') {
        syncEnabledState = 'none'
      } else if (
        isSynced(
          namespaceSyncState,
          this.#wantsToSyncData ? 'full' : 'initial',
          this.#peerSyncControllers
        )
      ) {
        syncEnabledState = 'none'
      } else if (this.#wantsToSyncData) {
        syncEnabledState = 'all'
      } else {
        syncEnabledState = 'presync'
      }
    } else if (this.#wantsToSyncData) {
      if (
        isSynced(
          namespaceSyncState,
          this.#wantsToSyncData ? 'full' : 'initial',
          this.#peerSyncControllers
        )
      ) {
        if (typeof this.#autostopDataSyncAfter === 'number') {
          this.#autostopDataSyncTimeout ??= setTimeout(() => {
            this.#wantsToSyncData = false
            this.#updateState()
          }, this.#autostopDataSyncAfter)
        }
      } else {
        this.#clearAutostopDataSyncTimeoutIfExists()
      }
      syncEnabledState = 'all'
    } else {
      this.#clearAutostopDataSyncTimeoutIfExists()
      syncEnabledState = 'presync'
    }

    if (syncEnabledState !== this.#previousSyncEnabledState) {
      this.#l.log(`Setting sync enabled state to "${syncEnabledState}"`)
    }
    for (const peerSyncController of this.#peerSyncControllers.values()) {
      peerSyncController.setSyncEnabledState(syncEnabledState)
    }

    this.#previousSyncEnabledState = syncEnabledState

    this.emit('sync-state', this.#getState(namespaceSyncState))
  }

  /**
   * @returns {void}
   */
  connectServers() {
    // TODO: decide how to handle this async stuff
    this.#getServerWebsocketUrls()
      .then((urls) => {
        for (const url of urls) {
          const existingWebsocket = this.#serverWebsockets.get(url)
          if (
            existingWebsocket &&
            (existingWebsocket.readyState === WebSocket.OPEN ||
              existingWebsocket.readyState === WebSocket.CONNECTING)
          ) {
            continue
          }

          const websocket = new WebSocket(url)
          // TODO: Handle websocket errors
          websocket.on('error', noop)

          // TODO: Handle errors (maybe with the `unexpected-response` event?)

          const replicationStream = this.#getReplicationStream()
          wsCoreReplicator(websocket, replicationStream)

          this.#serverWebsockets.set(url, websocket)
          websocket.once('close', () => {
            websocket.off('error', noop)
            this.#serverWebsockets.delete(url)
          })
        }
      })
      .catch(noop)
  }

  /**
   * @returns {void}
   */
  disconnectServers() {
    for (const websocket of this.#serverWebsockets.values()) {
      websocket.close()
    }
    this.#serverWebsockets.clear()
  }

  /**
   * Start syncing data cores.
   *
   * If the app is backgrounded and sync has already completed, this will do
   * nothing until the app is foregrounded.
   *
   * @param {object} [options]
   * @param {null | number} [options.autostopDataSyncAfter] If no data sync
   * happens after this duration in milliseconds, sync will be automatically
   * stopped as if {@link stop} was called.
   */
  start({ autostopDataSyncAfter } = {}) {
    this.#wantsToSyncData = true
    if (autostopDataSyncAfter === undefined) {
      this.#updateState()
    } else {
      this.setAutostopDataSyncTimeout(autostopDataSyncAfter)
    }
  }

  /**
   * Stop syncing data cores.
   *
   * Pre-sync cores will continue syncing unless the app is backgrounded.
   */
  stop() {
    this.#wantsToSyncData = false
    this.#updateState()
  }

  /**
   * Request a graceful stop to all sync.
   */
  [kRequestFullStop]() {
    this.#hasRequestedFullStop = true
    this.#updateState()
  }

  /**
   * Rescind any requests for a full stop.
   */
  [kRescindFullStopRequest]() {
    this.#hasRequestedFullStop = false
    this.#updateState()
  }

  /**
   * @param {null | number} autostopDataSyncAfter
   * @returns {void}
   */
  setAutostopDataSyncTimeout(autostopDataSyncAfter) {
    assertAutostopDataSyncAfterIsValid(autostopDataSyncAfter)
    this.#clearAutostopDataSyncTimeoutIfExists()
    this.#autostopDataSyncAfter = autostopDataSyncAfter
    this.#updateState()
  }

  /**
   * @param {SyncType} type
   * @returns {Promise<void>}
   */
  async waitForSync(type) {
    const state = this[kSyncState].getState()
    if (isSynced(state, type, this.#peerSyncControllers)) return
    return new Promise((res) => {
      const _this = this
      this[kSyncState].on('state', function onState(state) {
        if (!isSynced(state, type, _this.#peerSyncControllers)) return
        _this[kSyncState].off('state', onState)
        res()
      })
    })
  }

  /**
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async [kWaitForInitialSyncWithPeer](deviceId) {
    const state = this[kSyncState].getState()
    if (isInitiallySyncedWithPeer(state, deviceId)) return
    return new Promise((resolve) => {
      /** @param {import('./sync-state.js').State} state */
      const onState = (state) => {
        if (isInitiallySyncedWithPeer(state, deviceId)) {
          this[kSyncState].off('state', onState)
          resolve()
        }
      }
      this[kSyncState].on('state', onState)
    })
  }

  #clearAutostopDataSyncTimeoutIfExists() {
    if (this.#autostopDataSyncTimeout) {
      clearTimeout(this.#autostopDataSyncTimeout)
      this.#autostopDataSyncTimeout = null
    }
  }

  /**
   * Bound to `this`
   *
   * This will be called whenever a peer is successfully added to the creator
   * core, which means that the peer has the project key. The PeerSyncController
   * will then handle validation of role records to ensure that the peer is
   * actually still part of the project.
   *
   * @param {{ protomux: import('protomux')<OpenedNoiseStream> }} peer
   */
  #handlePeerAdd = (peer) => {
    const { protomux } = peer
    if (this.#peerSyncControllers.has(protomux)) {
      this.#l.log(
        'Unexpected existing peer sync controller for peer %h',
        protomux.stream.remotePublicKey
      )
      return
    }
    const peerSyncController = new PeerSyncController({
      protomux,
      coreManager: this.#coreManager,
      syncState: this[kSyncState],
      roles: this.#roles,
      logger: this.#l,
    })
    this.#peerSyncControllers.set(protomux, peerSyncController)
    this.#pscByPeerId.set(peerSyncController.peerId, peerSyncController)

    // Add peer to all core states (via namespace sync states)
    this[kSyncState].addPeer(peerSyncController.peerId)

    this.#updateState()

    const peerQueue = this.#pendingDiscoveryKeys.get(protomux)
    if (peerQueue) {
      for (const discoveryKey of peerQueue) {
        peerSyncController.handleDiscoveryKey(discoveryKey)
      }
      this.#pendingDiscoveryKeys.delete(protomux)
    }
  }

  /**
   * Bound to `this`
   *
   * Called when a peer is removed from the creator core, e.g. when the
   * connection is terminated.
   *
   * @param {{ protomux: import('protomux')<import('@hyperswarm/secret-stream')>, remotePublicKey: Buffer }} peer
   */
  #handlePeerDisconnect = (peer) => {
    const { protomux } = peer
    if (!this.#peerSyncControllers.has(protomux)) {
      this.#l.log(
        'Unexpected no existing peer sync controller for peer %h',
        protomux.stream.remotePublicKey
      )
      return
    }
    this.#peerSyncControllers.delete(protomux)
    const peerId = keyToId(peer.remotePublicKey)
    this.#pscByPeerId.delete(peerId)
    this.#pendingDiscoveryKeys.delete(protomux)
    this[kSyncState].disconnectPeer(peerId)
    this.#updateState()
  }

  /**
   * @param {Set<string>} roleDocIds
   * @returns {Promise<void>}
   */
  #handleRoleUpdate = async (roleDocIds) => {
    /** @type {Promise<CoreOwnershipDoc>[]} */ const coreOwnershipPromises = []
    for (const roleDocId of roleDocIds) {
      // Ignore docs about ourselves
      if (roleDocId === this.#coreManager.deviceId) continue
      coreOwnershipPromises.push(this.#coreOwnership.get(roleDocId))
    }

    const ownershipResults = await Promise.allSettled(coreOwnershipPromises)

    for (const result of ownershipResults) {
      if (result.status === 'rejected') continue
      await this.#validateRoleAndAddCoresForPeer(result.value)
    }
  }

  /**
   * @param {Set<string>} coreOwnershipDocIds
   * @returns {Promise<void>}
   */
  #handleCoreOwnershipUpdate = async (coreOwnershipDocIds) => {
    /** @type {Promise<void>[]} */ const promises = []

    for (const coreOwnershipDocId of coreOwnershipDocIds) {
      // Ignore our own ownership doc - we don't need to add cores for ourselves
      if (coreOwnershipDocId === this.#coreManager.deviceId) continue

      promises.push(
        (async () => {
          try {
            const coreOwnershipDoc = await this.#coreOwnership.get(
              coreOwnershipDocId
            )
            await this.#validateRoleAndAddCoresForPeer(coreOwnershipDoc)
          } catch (_) {
            // Ignore, we'll add these when the role is added
          }
        })()
      )
    }

    await Promise.all(promises)
  }

  /**
   * @param {CoreOwnershipDoc} coreOwnership
   * @returns {Promise<void>}
   */
  async #validateRoleAndAddCoresForPeer(coreOwnership) {
    const peerDeviceId = coreOwnership.docId
    const role = await this.#roles.getRole(peerDeviceId)
    // We only add cores for peers that have been explicitly written into the
    // project. If in the future we allow syncing from blocked peers, we can
    // drop the role check here, and just add cores.
    if (role.roleId === NO_ROLE_ID) return
    for (const ns of NAMESPACES) {
      if (ns === 'auth') continue
      const coreKey = Buffer.from(coreOwnership[`${ns}CoreId`], 'hex')
      this.#coreManager.addCore(coreKey, ns)
    }
    this.#l.log('Added non-auth cores for peer %S', peerDeviceId)
  }
}

/**
 * @param {null | number} ms
 * @returns {void}
 */
function assertAutostopDataSyncAfterIsValid(ms) {
  if (ms === null) return
  assert(
    ms > 0 && ms <= 2 ** 31 - 1 && Number.isSafeInteger(ms),
    'auto-stop timeout must be Infinity or a positive integer between 0 and the largest 32-bit signed integer'
  )
}

/**
 * Is the sync state "synced", e.g. is there nothing left to sync
 *
 * @param {import('./sync-state.js').State} state
 * @param {SyncType} type
 * @param {Map<import('protomux'), PeerSyncController>} peerSyncControllers
 */
function isSynced(state, type, peerSyncControllers) {
  const namespaces = type === 'initial' ? PRESYNC_NAMESPACES : NAMESPACES
  for (const ns of namespaces) {
    if (state[ns].dataToSync) return false
    for (const psc of peerSyncControllers.values()) {
      const { peerId } = psc
      if (psc.syncCapability[ns] === 'blocked') continue
      if (!(peerId in state[ns].remoteStates)) return false
      if (state[ns].remoteStates[peerId].status === 'starting') return false
    }
  }
  return true
}

/**
 * @param {import('./sync-state.js').State} state
 * @param {string} peerId
 */
function isInitiallySyncedWithPeer(state, peerId) {
  for (const ns of PRESYNC_NAMESPACES) {
    const remoteDeviceSyncState = getOwn(state[ns].remoteStates, peerId)
    if (!remoteDeviceSyncState) return false

    switch (remoteDeviceSyncState.status) {
      case 'starting':
        return false
      case 'started':
      case 'stopped': {
        const { want, wanted } = remoteDeviceSyncState
        if (want || wanted) return false
        break
      }
      default:
        throw new ExhaustivenessError(remoteDeviceSyncState.status)
    }
  }
  return true
}

/**
 * @param {import('./sync-state.js').State} namespaceSyncState
 * @param {Iterable<PeerSyncController>} peerSyncControllers
 * @returns {State['remoteDeviceSyncState']}
 */
function getRemoteDevicesSyncState(namespaceSyncState, peerSyncControllers) {
  /** @type {State['remoteDeviceSyncState']} */ const result = {}

  for (const psc of peerSyncControllers) {
    const { peerId } = psc

    /** @type {undefined | boolean} */ let isInitialEnabled
    /** @type {undefined | boolean} */ let isDataEnabled

    for (const namespace of NAMESPACES) {
      const isBlocked = psc.syncCapability[namespace] === 'blocked'
      if (isBlocked) continue

      const peerNamespaceState =
        namespaceSyncState[namespace].remoteStates[peerId]
      if (!peerNamespaceState) continue

      /** @type {boolean} */
      let isSyncEnabled
      switch (peerNamespaceState.status) {
        case 'stopped':
        case 'starting':
          isSyncEnabled = false
          break
        case 'started':
          isSyncEnabled = true
          break
        default:
          throw new ExhaustivenessError(peerNamespaceState.status)
      }

      if (!Object.hasOwn(result, peerId)) {
        result[peerId] = {
          initial: { isSyncEnabled: false, want: 0, wanted: 0 },
          data: { isSyncEnabled: false, want: 0, wanted: 0 },
        }
      }

      /** @type {'initial' | 'data'} */ let namespaceGroup
      const isPresyncNamespace = PRESYNC_NAMESPACES.includes(namespace)
      if (isPresyncNamespace) {
        namespaceGroup = 'initial'
        isInitialEnabled = (isInitialEnabled ?? true) && isSyncEnabled
      } else {
        namespaceGroup = 'data'
        isDataEnabled = (isDataEnabled ?? true) && isSyncEnabled
      }

      result[peerId][namespaceGroup].want += peerNamespaceState.want
      result[peerId][namespaceGroup].wanted += peerNamespaceState.wanted
    }

    if (Object.hasOwn(result, peerId)) {
      result[peerId].initial.isSyncEnabled = Boolean(isInitialEnabled)
      result[peerId].data.isSyncEnabled = Boolean(isDataEnabled)
    }
  }

  return result
}
