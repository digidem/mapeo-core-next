// @ts-check
import { TypedEmitter } from 'tiny-typed-emitter'
import Protomux from 'protomux'
import { assert, ExhaustivenessError, keyToId, noop } from './utils.js'
import { isBlank } from './lib/string.js'
import cenc from 'compact-encoding'
import {
  DeviceInfo,
  Invite,
  InviteCancel,
  InviteResponse,
  ProjectJoinDetails,
} from './generated/rpc.js'
import pDefer from 'p-defer'
import { Logger } from './logger.js'
import pTimeout, { TimeoutError } from 'p-timeout'

// Unique identifier for the mapeo rpc protocol
const PROTOCOL_NAME = 'mapeo/rpc'
// Timeout in milliseconds to wait for a peer to connect when trying to send a message
const SEND_TIMEOUT = 1000
// Timeout in milliseconds to wait for peer deduplication
const DEDUPE_TIMEOUT = 1000

// Protomux message types depend on the order that messages are added to a
// channel (this needs to remain consistent). To avoid breaking changes, the
// types here should not change.
/** @satisfies {{ [k in keyof typeof import('./generated/rpc.js')]?: number }} */
const MESSAGE_TYPES = {
  Invite: 0,
  InviteCancel: 1,
  InviteResponse: 2,
  ProjectJoinDetails: 3,
  DeviceInfo: 4,
}
const MESSAGES_MAX_ID = Math.max.apply(null, [...Object.values(MESSAGE_TYPES)])

/**
 * @typedef {object} PeerInfoBase
 * @property {string} deviceId
 * @property {string | undefined} name
 * @property {import('./generated/rpc.js').DeviceInfo['deviceType']} deviceType
 */
/** @typedef {PeerInfoBase & { status: 'connecting' }} PeerInfoConnecting */
/** @typedef {PeerInfoBase & { status: 'connected', connectedAt: number, protomux: Protomux<import('@hyperswarm/secret-stream')> }} PeerInfoConnected */
/** @typedef {PeerInfoBase & { status: 'disconnected', disconnectedAt: number }} PeerInfoDisconnected */

/** @typedef {PeerInfoConnecting | PeerInfoConnected | PeerInfoDisconnected} PeerInfoInternal */
/** @typedef {PeerInfoConnected | PeerInfoDisconnected} PeerInfo */
/** @typedef {PeerInfoInternal['status']} PeerState */

class Peer {
  /** @type {PeerState} */
  #state = 'connecting'
  #deviceId
  #channel
  #connected
  /** @type {string | undefined} */
  #name
  /** @type {DeviceInfo['deviceType']} */
  #deviceType
  #connectedAt = 0
  #disconnectedAt = 0
  #protomux
  #log

  /**
   * @param {object} options
   * @param {string} options.peerId
   * @param {ReturnType<typeof Protomux.prototype.createChannel>} options.channel
   * @param {Protomux<any>} options.protomux
   * @param {Logger} [options.logger]
   */
  constructor({ peerId, channel, protomux, logger }) {
    this.#deviceId = peerId
    this.#channel = channel
    this.#protomux = protomux
    this.#connected = pDefer()
    // Avoid unhandled rejections
    this.#connected.promise.catch(noop)
    // @ts-ignore
    this.#log = (formatter, ...args) => {
      const log = Logger.create('peer', logger).log
      return log.apply(null, [`[%S] ${formatter}`, peerId, ...args])
    }
  }
  /** @returns {PeerInfoInternal} */
  get info() {
    switch (this.#state) {
      case 'connecting':
        return {
          status: this.#state,
          deviceId: this.#deviceId,
          name: this.#name,
          deviceType: this.#deviceType,
        }
      case 'connected':
        return {
          status: this.#state,
          deviceId: this.#deviceId,
          name: this.#name,
          deviceType: this.#deviceType,
          connectedAt: this.#connectedAt,
          protomux: this.#protomux,
        }
      case 'disconnected':
        return {
          status: this.#state,
          deviceId: this.#deviceId,
          name: this.#name,
          deviceType: this.#deviceType,
          disconnectedAt: this.#disconnectedAt,
        }
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(this.#state)
    }
  }
  /**
   * A promise that resolves when the peer connects, or rejects if it
   * fails to connect
   */
  get connected() {
    return this.#connected.promise
  }
  get protomux() {
    return this.#protomux
  }

  connect() {
    /* c8 ignore next 4 */
    if (this.#state !== 'connecting') {
      this.#log('ERROR: tried to connect but state was %s', this.#state)
      return // TODO: report error - this should not happen
    }
    this.#state = 'connected'
    this.#connectedAt = Date.now()
    this.#connected.resolve()
    this.#log('connected')
  }
  disconnect() {
    // @ts-ignore - easier to ignore this than handle this for TS - avoids holding a reference to old Protomux instances
    this.#protomux = undefined
    /* c8 ignore next 4 */
    if (this.#state === 'disconnected') {
      this.#log('ERROR: tried to disconnect but was already disconnected')
      return
    }
    this.#state = 'disconnected'
    this.#disconnectedAt = Date.now()
    // This promise should have already resolved, but if the peer never connected then we reject here
    this.#connected.reject(new PeerFailedConnectionError())
    this.#log('disconnected')
  }
  /** @param {Invite} invite */
  sendInvite(invite) {
    this.#assertConnected()
    const buf = Buffer.from(Invite.encode(invite).finish())
    const messageType = MESSAGE_TYPES.Invite
    this.#channel.messages[messageType].send(buf)
    this.#log('sent invite %h', invite.inviteId)
  }
  /** @param {InviteCancel} inviteCancel */
  sendInviteCancel(inviteCancel) {
    this.#assertConnected()
    const buf = Buffer.from(InviteCancel.encode(inviteCancel).finish())
    const messageType = MESSAGE_TYPES.InviteCancel
    this.#channel.messages[messageType].send(buf)
    this.#log('sent invite cancel %h', inviteCancel.inviteId)
  }
  /** @param {InviteResponse} response */
  sendInviteResponse(response) {
    this.#assertConnected()
    const buf = Buffer.from(InviteResponse.encode(response).finish())
    const messageType = MESSAGE_TYPES.InviteResponse
    this.#channel.messages[messageType].send(buf)
    this.#log('sent response for %h: %s', response.inviteId, response.decision)
  }
  /** @param {ProjectJoinDetails} details */
  sendProjectJoinDetails(details) {
    this.#assertConnected()
    const buf = Buffer.from(ProjectJoinDetails.encode(details).finish())
    const messageType = MESSAGE_TYPES.ProjectJoinDetails
    this.#channel.messages[messageType].send(buf)
    this.#log('sent project join details for %h', details.projectKey)
  }
  /** @param {DeviceInfo} deviceInfo */
  sendDeviceInfo(deviceInfo) {
    const buf = Buffer.from(DeviceInfo.encode(deviceInfo).finish())
    const messageType = MESSAGE_TYPES.DeviceInfo
    this.#channel.messages[messageType].send(buf)
    this.#log('sent deviceInfo %o', deviceInfo)
  }
  /** @param {DeviceInfo} deviceInfo */
  receiveDeviceInfo(deviceInfo) {
    this.#name = deviceInfo.name
    this.#deviceType = deviceInfo.deviceType
    this.#log('received deviceInfo %o', deviceInfo)
  }
  #assertConnected() {
    if (this.#state === 'connected' && !this.#channel.closed) return
    /* c8 ignore next */
    throw new PeerDisconnectedError() // TODO: report error - this should not happen
  }
}

/**
 * @typedef {object} LocalPeersEvents
 * @property {(peers: PeerInfo[]) => void} peers Emitted whenever the connection status of peers changes. An array of peerInfo objects with a peer id and the peer connection status
 * @property {(peer: PeerInfoConnected) => void} peer-add Emitted when a new peer is connected
 * @property {(peerId: string, invite: Invite) => void} invite Emitted when an invite is received
 * @property {(peerId: string, invite: InviteCancel) => void} invite-cancel Emitted when we receive a cancelation for an invite
 * @property {(peerId: string, inviteResponse: InviteResponse) => void} invite-response Emitted when an invite response is received
 * @property {(peerId: string, details: ProjectJoinDetails) => void} got-project-details Emitted when project details are received
 * @property {(discoveryKey: Buffer, protomux: Protomux<import('@hyperswarm/secret-stream')>) => void} discovery-key Emitted when a new hypercore is replicated (by a peer) to a peer protomux instance (passed as the second parameter)
 */

/** @extends {TypedEmitter<LocalPeersEvents>} */
export class LocalPeers extends TypedEmitter {
  /** @type {Map<string, Set<Peer>>} */
  #peers = new Map()
  /** @type {Set<Peer>} */
  #lastEmittedPeers = new Set()
  /** @type {Set<Promise<any>>} */
  #opening = new Set()

  #l
  /** @type {Set<Protomux>} */
  #attached = new Set()

  /**
   *
   * @param {object} [opts]
   * @param {Logger} [opts.logger]
   */
  constructor({ logger } = {}) {
    super()
    this.#l = Logger.create('localPeers', logger)
  }

  get peers() {
    const connectedPeerInfos = []
    for (const { info } of this.#getPeers()) {
      connectedPeerInfos.push(info)
    }
    return connectedPeerInfos
  }

  /**
   * @param {string} deviceId
   * @param {Invite} invite
   * @returns {Promise<void>}
   */
  async sendInvite(deviceId, invite) {
    await this.#waitForPendingConnections()
    const peer = await this.#getPeerByDeviceId(deviceId)
    peer.sendInvite(invite)
  }

  /**
   * @param {string} deviceId
   * @param {InviteCancel} inviteCancel
   * @returns {Promise<void>}
   */
  async sendInviteCancel(deviceId, inviteCancel) {
    await this.#waitForPendingConnections()
    const peer = await this.#getPeerByDeviceId(deviceId)
    peer.sendInviteCancel(inviteCancel)
  }

  /**
   * Respond to an invite from a peer
   *
   * @param {string} deviceId id of the peer you want to respond to (publicKey of peer as hex string)
   * @param {InviteResponse} inviteResponse
   */
  async sendInviteResponse(deviceId, inviteResponse) {
    await this.#waitForPendingConnections()
    const peer = await this.#getPeerByDeviceId(deviceId)
    peer.sendInviteResponse(inviteResponse)
  }

  /**
   * @param {string} deviceId
   * @param {ProjectJoinDetails} details
   */
  async sendProjectJoinDetails(deviceId, details) {
    await this.#waitForPendingConnections()
    const peer = await this.#getPeerByDeviceId(deviceId)
    peer.sendProjectJoinDetails(details)
  }

  /**
   *
   * @param {string} deviceId id of the peer you want to send to (publicKey of peer as hex string)
   * @param {DeviceInfo} deviceInfo device info to send
   */
  async sendDeviceInfo(deviceId, deviceInfo) {
    await this.#waitForPendingConnections()
    const peer = await this.#getPeerByDeviceId(deviceId)
    peer.sendDeviceInfo(deviceInfo)
  }

  /**
   * Connect to a peer over an existing NoiseSecretStream
   *
   * @param {import('./types.js').NoiseStream<any>} stream a NoiseSecretStream from @hyperswarm/secret-stream
   * @returns {import('./types.js').ReplicationStream}
   */
  connect(stream) {
    const noiseStream = stream.noiseStream
    if (!noiseStream) throw new Error('Invalid stream')
    const outerStream = noiseStream.rawStream
    const protomux =
      noiseStream.userData && Protomux.isProtomux(noiseStream.userData)
        ? noiseStream.userData
        : Protomux.from(noiseStream)
    noiseStream.userData = protomux

    if (this.#attached.has(protomux)) return outerStream

    protomux.pair(
      { protocol: 'hypercore/alpha' },
      /** @param {Buffer} discoveryKey */ async (discoveryKey) => {
        this.#l.log(
          'Received discovery key %h from %h',
          discoveryKey,
          stream.noiseStream.remotePublicKey
        )
        this.emit('discovery-key', discoveryKey, protomux)
      }
    )

    const deferredOpen = pDefer()
    this.#opening.add(deferredOpen.promise)
    // Called when either the peer opens or disconnects before open
    const done = () => {
      deferredOpen.resolve()
      this.#opening.delete(deferredOpen.promise)
    }

    const makePeer = this.#makePeer.bind(this, protomux, done)

    this.#attached.add(protomux)
    // This happens when the connected peer opens the channel
    protomux.pair(
      { protocol: PROTOCOL_NAME },
      // @ts-ignore - need to update protomux types
      makePeer
    )
    noiseStream.once('close', () => {
      this.#attached.delete(protomux)
      done()
    })

    noiseStream.opened.then((opened) => {
      // Once the noise stream is opened, we attempt to open the channel ourself
      // (the peer may have already done this, in which case this is a no-op)
      if (opened) makePeer()
    })

    return outerStream
  }

  /**
   * @param {Protomux<import('./utils.js').OpenedNoiseStream>} protomux
   * @param {() => void} done
   */
  #makePeer(protomux, done) {
    // #makePeer is called when the noise stream is opened, but it is also
    // called when the connected peer tries to open the channel. We only want
    // one channel, so we ignore attempts to create a peer if the channel is
    // already open
    if (protomux.opened({ protocol: PROTOCOL_NAME })) return done()

    const peerId = keyToId(protomux.stream.remotePublicKey)

    // This is written like this because the protomux uses the index within
    // the messages array to define the message id over the wire, so this must
    // stay consistent to avoid breaking protocol changes.
    /** @type {Parameters<typeof Protomux.prototype.createChannel>[0]['messages']} */
    const messages = new Array(MESSAGES_MAX_ID).fill(undefined)
    for (const [type, id] of Object.entries(MESSAGE_TYPES)) {
      messages[id] = {
        encoding: cenc.raw,
        onmessage: (message) => {
          try {
            this.#handleMessage(
              protomux,
              /** @type {keyof typeof MESSAGE_TYPES} */ (type),
              message
            )
          } catch (err) {
            this.#l.log(`Error handling ${type} message: ${String(err)}`)
          }
        },
      }
    }

    const channel = protomux.createChannel({
      userData: null,
      protocol: PROTOCOL_NAME,
      messages,
      onopen: () => {
        peer.connect()
        this.#emitPeers()
        done()
      },
      onclose: () => {
        // TODO: Track reasons for closing
        peer.disconnect()
        // We keep disconnected peers around, but not duplicates
        if (existingDevicePeers.size > 1) {
          // TODO: Decide which existing peer to delete
          existingDevicePeers.delete(peer)
        }
        this.#attached.delete(peer.protomux)
        this.#emitPeers()
        done()
      },
    })
    channel.open()

    const existingDevicePeers = this.#peers.get(peerId) || new Set()
    const peer = new Peer({
      peerId,
      protomux,
      channel,
      logger: this.#l,
    })
    existingDevicePeers.add(peer)
    this.#peers.set(peerId, existingDevicePeers)
    // Do not emit peers now - will emit when connected
  }

  /**
   * @param {Protomux<import('./utils.js').OpenedNoiseStream>} protomux
   */
  #getPeerByProtomux(protomux) {
    // We could also index peers by protomux to avoid this, but that would mean
    // we need to keep around protomux references for closed peers, and we keep
    // around closed peers for the lifecycle of the app
    const peerId = keyToId(protomux.stream.remotePublicKey)
    // We could have more than one connection to the same peer
    const devicePeers = this.#peers.get(peerId)
    /** @type {Peer | undefined} */
    let peer
    for (const devicePeer of devicePeers || []) {
      if (devicePeer.protomux === protomux) {
        peer = devicePeer
      }
    }
    return peer
  }

  #getPeers() {
    /** @type {Set<Peer & { info: PeerInfoConnected | PeerInfoDisconnected }>} */
    const peers = new Set()
    for (const devicePeers of this.#peers.values()) {
      const peer = chooseDevicePeer(devicePeers)
      if (peer) peers.add(peer)
    }
    return peers
  }

  #emitPeers() {
    const currentPeers = this.#getPeers()
    const connectedPeerInfos = []
    for (const peer of currentPeers) {
      if (
        !this.#lastEmittedPeers.has(peer) &&
        peer.info.status === 'connected'
      ) {
        // Any new peers that have 'connected' status
        this.emit('peer-add', peer.info)
      }
      connectedPeerInfos.push(peer.info)
    }
    if (currentPeers.size > 0 || this.#lastEmittedPeers.size > 0) {
      // Don't emit empty array unless somehow it was not empty before
      this.emit('peers', connectedPeerInfos)
    }
    this.#lastEmittedPeers = currentPeers
  }

  /**
   *
   * @param {Protomux<import('./utils.js').OpenedNoiseStream>} protomux
   * @param {keyof typeof MESSAGE_TYPES} type
   * @param {Buffer} value
   */
  #handleMessage(protomux, type, value) {
    const peer = this.#getPeerByProtomux(protomux)
    /* c8 ignore next */
    if (!peer) return // TODO: report error - this should not happen
    switch (type) {
      case 'Invite': {
        const invite = parseInvite(value)
        const peerId = keyToId(protomux.stream.remotePublicKey)
        this.emit('invite', peerId, invite)
        this.#l.log(
          'Invite %h from %S for %h',
          invite.inviteId,
          peerId,
          invite.projectPublicId
        )
        break
      }
      case 'InviteCancel': {
        const inviteCancel = parseInviteCancel(value)
        const peerId = keyToId(protomux.stream.remotePublicKey)
        this.emit('invite-cancel', peerId, inviteCancel)
        this.#l.log(
          'Invite cancel from %S for %h',
          peerId,
          inviteCancel.inviteId
        )
        break
      }
      case 'InviteResponse': {
        const inviteResponse = parseInviteResponse(value)
        const peerId = keyToId(protomux.stream.remotePublicKey)
        this.emit('invite-response', peerId, inviteResponse)
        break
      }
      case 'ProjectJoinDetails': {
        const details = parseProjectJoinDetails(value)
        const peerId = keyToId(protomux.stream.remotePublicKey)
        this.emit('got-project-details', peerId, details)
        break
      }
      case 'DeviceInfo': {
        const deviceInfo = DeviceInfo.decode(value)
        peer.receiveDeviceInfo(deviceInfo)
        this.#emitPeers()
        break
      }
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(type)
    }
  }

  /**
   * Wait for any connections that are currently opening
   */
  #waitForPendingConnections() {
    return pTimeout(Promise.all(this.#opening), { milliseconds: SEND_TIMEOUT })
  }

  /**
   * Get a peer by deviceId. We can have more than one connection per device, in
   * which case we wait for deduplication. Also waits for a peer to be connected
   *
   * @param {string} deviceId
   * @returns {Promise<Peer & { info: PeerInfoConnected | PeerInfoDisconnected }>}
   */
  async #getPeerByDeviceId(deviceId) {
    const devicePeers = this.#peers.get(deviceId)
    if (!devicePeers || devicePeers.size === 0) {
      throw new UnknownPeerError('Unknown peer ' + deviceId.slice(0, 7))
    }
    const peer = chooseDevicePeer(devicePeers)
    if (peer) return peer
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.off('peers', onPeers)
        reject(new UnknownPeerError('Unknown peer ' + deviceId.slice(0, 7)))
      }, DEDUPE_TIMEOUT)

      const onPeers = () => {
        if (!devicePeers) return // Not possible, but let's keep TS happy
        const peer = chooseDevicePeer(devicePeers)
        if (!peer) return
        clearTimeout(timeoutId)
        this.off('peers', onPeers)
        resolve(peer)
      }

      this.on('peers', onPeers)
    })
  }
}

export { TimeoutError }

export class UnknownPeerError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message)
    this.name = 'UnknownPeerError'
  }
}

export class PeerDisconnectedError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message)
    this.name = 'PeerDisconnectedError'
  }
}

export class PeerFailedConnectionError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message)
    this.name = 'PeerFailedConnectionError'
  }
}

/**
 * @param {Readonly<Uint8Array>} id
 * @throws if the invite ID is too short
 */
function assertInviteIdIsValid(id) {
  assert(id.byteLength >= 32, 'Invite ID must be >= 32 bytes')
}

/**
 * @param {Readonly<Uint8Array>} data
 * @throws if the data is invalid
 * @returns {Invite}
 */
function parseInvite(data) {
  const result = Invite.decode(data)
  assertInviteIdIsValid(result.inviteId)
  assert(result.projectPublicId.length, 'Invite must have project public ID')
  assert(!isBlank(result.projectName), 'Invite project name cannot be blank')
  assert(!isBlank(result.invitorName), 'Invite invitor name cannot be blank')
  return result
}

/**
 * @param {Readonly<Uint8Array>} data
 * @throws if the data is invalid
 * @returns {InviteCancel}
 */
function parseInviteCancel(data) {
  const result = InviteCancel.decode(data)
  assertInviteIdIsValid(result.inviteId)
  return result
}

/**
 * @param {Readonly<Uint8Array>} data
 * @throws if the data is invalid
 * @returns {InviteResponse}
 */
function parseInviteResponse(data) {
  const result = InviteResponse.decode(data)
  assertInviteIdIsValid(result.inviteId)
  return result
}

/**
 * @param {Readonly<Uint8Array>} data
 * @throws if the data is invalid
 * @returns {ProjectJoinDetails}
 */
function parseProjectJoinDetails(data) {
  const result = ProjectJoinDetails.decode(data)
  assertInviteIdIsValid(result.inviteId)
  assert(result.projectKey.length, 'Project join details must have project key')
  assert(
    result.encryptionKeys?.auth?.byteLength,
    'Project join details must have auth encryption keys'
  )
  return result
}

/**
 * We can temporarily have more than 1 peer for a device while connections are
 * deduplicating. We don't expose these duplicate connections until only one
 * connection exists per device, however if somehow we end up with more than one
 * connection with a peer and it is not deduplicated, then we expose the oldest
 * connection, or the most recent disconnect.
 *
 * @param {Set<Peer>} devicePeers
 * @returns {undefined | Peer & { info: PeerInfoConnected | PeerInfoDisconnected }}
 */
function chooseDevicePeer(devicePeers) {
  if (devicePeers.size === 0) return
  let [pick] = devicePeers
  if (devicePeers.size > 1) {
    for (const peer of devicePeers) {
      // If one of the peers for a device is connecting, skip - we'll wait
      // until it's connected before returning it.
      if (peer.info.status === 'connecting') return
      if (peer.info.status === 'connected') {
        if (pick.info.status !== 'connected') {
          // Always expose the connected peer if there is one
          pick = peer
        } else if (peer.info.connectedAt < pick.info.connectedAt) {
          // If more than one peer is connected, pick the one connected for the longest time
          pick = peer
        }
      } else if (
        pick.info.status === 'disconnected' &&
        peer.info.disconnectedAt > pick.info.disconnectedAt
      ) {
        // If all peers are disconnected, pick the most recently disconnected
        pick = peer
      }
    }
  }
  // Don't expose peers that are connecting, wait until they have connected (or disconnected)
  if (pick.info.status === 'connecting') return
  // @ts-ignore
  return pick
}
