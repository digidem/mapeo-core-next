import { TypedEmitter } from 'tiny-typed-emitter'
import { keyToId } from '../utils.js'
import RemoteBitfield from './remote-bitfield.js'

/**
 * @typedef {RemoteBitfield} Bitfield
 */
/**
 * @typedef {string} PeerId
 */
/**
 * @typedef {Object} InternalState
 * @property {number | undefined} length Core length, e.g. how many blocks in the core (including blocks that are not downloaded)
 * @property {PeerState} localState
 * @property {Map<PeerId, PeerState>} remoteStates
 */
/**
 * @typedef {object} PeerSimpleState
 * @property {number} have blocks the peer has locally
 * @property {number} want blocks the peer wants, and at least one peer has
 * @property {number} wanted blocks the peer has that at least one peer wants
 * @property {number} missing blocks the peer wants but no peer has
 */
/**
 * @typedef {PeerSimpleState & { connected: boolean }} RemotePeerSimpleState
 */
/**
 * @typedef {object} DerivedState
 * @property {number} coreLength known (sparse) length of the core
 * @property {PeerSimpleState} localState local state
 * @property {Record<PeerId, RemotePeerSimpleState>} remoteStates map of state of all known peers
 */
/**
 * @typedef {object} CoreReplicationEvents
 * @property {() => void} update
 */

/**
 * Track replication state for a core identified by `discoveryId`. Can start
 * tracking state before the core instance exists locally, via the "preHave"
 * messages received over the project creator core.
 *
 * Because deriving the state is expensive (it iterates through the bitfields of
 * all peers), this is designed to be pull-based: an `update` event signals that
 * the state is updated, but does not pass the state. The consumer can "pull"
 * the state when it wants it via `coreReplicationState.getState()`.
 *
 * Each peer (including the local peer) has a state of:
 *   1. `have` - number of blocks the peer has locally
 *   2. `want` - number of blocks the peer wants, and at least one peer has
 *   3. `wanted` - number of blocks the peer has that at least one peer wants
 *   4. `missing` - number of blocks the peer wants but no peer has
 *
 * @extends {TypedEmitter<CoreReplicationEvents>}
 */
export class CoreReplicationState extends TypedEmitter {
  /** @type {import('hypercore')<'binary', Buffer>} */
  #core
  /** @type {InternalState['remoteStates']} */
  #remoteStates = new Map()
  /** @type {InternalState['localState']} */
  #localState = new PeerState()
  #discoveryId
  /** @type {DerivedState | null} */
  #cachedState = null

  /**
   * @param {string} discoveryId Discovery ID for the core that this is representing
   */
  constructor(discoveryId) {
    super()
    this.#discoveryId = discoveryId
  }

  /** @type {() => DerivedState} */
  getState() {
    if (this.#cachedState) return this.#cachedState
    return deriveState({
      length: this.#core?.length,
      localState: this.#localState,
      remoteStates: this.#remoteStates,
    })
  }

  /**
   * Called whenever the state changes, so we clear the cache because next call
   * to getState() will need to re-derive the state
   */
  #update() {
    this.#cachedState = null
    this.emit('update')
  }

  /**
   * Attach a core. The replication state can be initialized without a core
   * instance, because we could receive peer want and have states via extension
   * messages before we have the core key that allows us to create a core
   * instance.
   *
   * @param {import('hypercore')<'binary', Buffer>} core
   */
  attachCore(core) {
    // @ts-ignore - we know discoveryKey exists here
    const discoveryId = keyToId(core.discoveryKey)
    if (discoveryId !== this.#discoveryId) {
      throw new Error('discoveryId does not match')
    }
    if (!this.#core) return

    this.#core = core
    // @ts-ignore - internal property
    this.#localState.setHavesBitfield(core?.core?.bitfield)

    for (const peer of this.#core.peers) {
      this.#onPeerAdd(peer)
    }

    this.#core.on('peer-add', this.#onPeerAdd)

    this.#core.on('peer-remove', this.#onPeerRemove)

    // TODO: Maybe we need to also wait on core.update() and then emit state?

    // These events happen when the local bitfield changes, so we want to emit
    // state because it will have changed
    this.#core.on('download', () => {
      this.#update()
    })

    this.#core.on('append', () => {
      this.#update()
    })
  }

  /**
   * Add a pre-emptive "have" bitfield for a peer. This is used when we receive
   * a peer "have" via extension message - it allows us to have a state for the
   * peer before the peer actually starts replicating this core
   *
   * @param {PeerId} peerId
   * @param {Bitfield} bitfield
   */
  setHavesBitfield(peerId, bitfield) {
    const peerState = this.#getPeerState(peerId)
    peerState.setPreHavesBitfield(bitfield)
    this.#update()
  }

  /**
   * Add a ranges of wanted blocks for a peer. By default a peer wants all
   * blocks in a core - calling this will change the peer to only want the
   * blocks/ranges that are added here
   *
   * @param {PeerId} peerId
   * @param {Array<{ start: number, length: number }>} ranges
   */
  setPeerWants(peerId, ranges) {
    const peerState = this.#getPeerState(peerId)
    for (const { start, length } of ranges) {
      peerState.setWantRange({ start, length })
    }
    this.#update()
  }

  /**
   * @param {PeerId} peerId
   */
  #getPeerState(peerId) {
    let peerState = this.#remoteStates.get(peerId)
    if (!peerState) {
      peerState = new PeerState()
      this.#remoteStates.set(peerId, peerState)
    }
    return peerState
  }

  /**
   * Handle a peer being added to the core - updates state and adds listeners to
   * emit state updates whenever the peer remote bitfield changes
   *
   * (defined as class field to bind to `this`)
   * @param {any} peer
   */
  #onPeerAdd = (peer) => {
    const peerId = keyToId(peer.remotePublicId)

    // Update state to ensure this peer is in the state and set to connected
    const peerState = this.#getPeerState(peerId)
    peerState.connected = true

    // A peer can have a pre-emptive "have" bitfield received via an extension
    // message, but when the peer actually connects then we switch to the actual
    // bitfield from the peer object
    peerState.setHavesBitfield(peer.remoteBitfield)
    this.#update()

    // We want to emit state when a peer's bitfield changes, which can happen as
    // a result of these two internal calls.
    const originalOnBitfield = peer.onbitfield
    const originalOnRange = peer.onrange
    peer.onbitfield = (/** @type {any[]} */ ...args) => {
      originalOnBitfield.apply(peer, args)
      this.#update()
    }
    peer.onrange = (/** @type {any[]} */ ...args) => {
      originalOnRange.apply(peer, args)
      this.#update()
    }
  }

  /**
   * Handle a peer being removed - keeps it in state, but sets state.connected = false
   *
   * (defined as class field to bind to `this`)
   * @param {any} peer
   */
  #onPeerRemove = (peer) => {
    const peerId = keyToId(peer.remotePublicKey)
    const peerState = this.#getPeerState(peerId)
    peerState.connected = false
    this.#update()
  }
}

class PeerState {
  /** @type {Bitfield | undefined} */
  #preHaves
  /** @type {Bitfield | undefined} */
  #haves
  /** @type {Bitfield | undefined} */
  #wants
  connected = false
  /**
   * @param {Bitfield} bitfield
   */
  setPreHavesBitfield(bitfield) {
    this.#preHaves = bitfield
  }
  /**
   * @param {Bitfield} bitfield
   */
  setHavesBitfield(bitfield) {
    this.#haves = bitfield
  }
  /**
   * @param {Bitfield} bitfield
   */
  setWantsBitfield(bitfield) {
    this.#wants = bitfield
  }
  /**
   *
   * @param {{ start: number, length: number }} range
   */
  setWantRange({ start, length }) {
    if (!this.#wants) this.#wants = new RemoteBitfield()
    this.#wants.setRange(start, length, true)
  }
  /**
   * @param {number} index
   */
  have(index) {
    return this.#haves?.get(index) || this.#preHaves?.get(index) || false
  }
  /**
   * @param {number} index
   */
  want(index) {
    return this.#wants?.get(index) || true
  }
}

/**
 * Derive count for each peer: "want"; "have"; "wanted". There is definitely a
 * more performant and clever way of doing this, but at least with this
 * implementation I can understand what I am doing.
 *
 * @param {InternalState} coreState
 */
function deriveState(coreState) {
  const peerIds = ['local', ...coreState.remoteStates.keys()]
  const peers = [coreState.localState, ...coreState.remoteStates.values()]

  /** @type {PeerSimpleState[]} */
  const peerStates = new Array(peers.length)
  const length = coreState.length || 0
  for (let i = 0; i < peerStates.length; i++) {
    peerStates[i] = { want: 0, have: 0, wanted: 0, missing: 0 }
  }
  for (let i = 0; i < length; i++) {
    const haves = new Array(peerStates.length)
    const wants = new Array(peerStates.length)
    let someoneHasIt = false
    for (const [j, peer] of peers.entries()) {
      haves[j] = peer.have(i)
      if (haves[j]) {
        someoneHasIt = true
        peerStates[j].have += 1
      }
    }
    let someoneWantsIt = false
    for (const [j, peer] of peers.entries()) {
      // A block is a want if:
      //   1. The peer wants it
      //   2. They don't have it
      //   3. Someone does have it
      const wouldLikeIt = peer.want(i) && !haves[j]
      wants[j] = wouldLikeIt && someoneHasIt
      if (wants[j]) {
        someoneWantsIt = true
        peerStates[j].want += 1
      }
      if (wouldLikeIt && !someoneHasIt) {
        peerStates[j].missing += 1
      }
    }
    for (let j = 0; j < peerStates.length; j++) {
      // A block is wanted if:
      //   1. Someone wants it
      //   2. The peer has it
      const wanted = someoneWantsIt && haves[j]
      if (wanted) {
        peerStates[j].wanted += 1
      }
    }
  }
  /** @type {DerivedState} */
  const derivedState = {
    coreLength: length,
    localState: peerStates[0],
    remoteStates: {},
  }
  for (let j = 1; j < peerStates.length; j++) {
    const peerState = /** @type {RemotePeerSimpleState} */ (peerStates[j])
    peerState.connected = peers[j].connected
    derivedState.remoteStates[peerIds[j]] = peerState
  }
  return derivedState
}
