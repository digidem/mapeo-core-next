import { TypedEmitter } from 'tiny-typed-emitter'
import net from 'node:net'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { once } from 'node:events'
import { noop } from '../utils.js'
import { DnsSd } from './dns-sd.js'
import { isPrivate } from 'bogon'
import StartStopStateMachine from 'start-stop-state-machine'
import pTimeout from 'p-timeout'
import { keyToPublicId } from '@mapeo/crypto'
import { Logger } from '../logger.js'

/** @typedef {{ publicKey: Buffer, secretKey: Buffer }} Keypair */
/** @typedef {import('../utils.js').OpenedNoiseStream<net.Socket>} OpenedNoiseStream */

export const ERR_DUPLICATE = 'Duplicate connection'

/**
 * @typedef {Object} DiscoveryEvents
 * @property {(connection: OpenedNoiseStream) => void} connection
 */

/**
 * @extends {TypedEmitter<DiscoveryEvents>}
 */
export class LocalDiscovery extends TypedEmitter {
  #identityKeypair
  #server
  /** @type {Map<string, OpenedNoiseStream>} */
  #noiseConnections = new Map()
  #dnssd
  #sm
  #log
  /** @type {(e: Error) => void} */
  #handleSocketError
  #l

  /**
   * @param {Object} opts
   * @param {Keypair} opts.identityKeypair
   * @param {DnsSd} [opts.dnssd] Optional DnsSd instance, used for testing
   * @param {Logger} [opts.logger]
   */
  constructor({ identityKeypair, dnssd, logger }) {
    super()
    this.#l = Logger.create('mdns', logger)
    this.#log = this.#l.log.bind(this.#l)
    this.#dnssd =
      dnssd ||
      new DnsSd({
        name: keyToPublicId(identityKeypair.publicKey),
        logger: this.#l,
      })
    this.#dnssd.on('up', this.#handleServiceUp.bind(this))
    this.#sm = new StartStopStateMachine({
      start: this.#start.bind(this),
      stop: this.#stop.bind(this),
    })
    this.#handleSocketError = (e) => {
      this.#log('socket error', e.message)
    }
    this.#identityKeypair = identityKeypair
    this.#server = net.createServer(this.#handleTcpConnection.bind(this, false))
    this.#server.on('error', (e) => {
      this.#log('Server error', e)
    })
  }

  get publicKey() {
    return this.#identityKeypair.publicKey
  }

  address() {
    return this.#server.address()
  }

  async start() {
    return this.#sm.start()
  }

  async #start() {
    // start browsing straight away
    this.#dnssd.browse()

    // Let OS choose port, listen on ip4, all interfaces
    this.#server.listen(0, '0.0.0.0')
    await once(this.#server, 'listening')
    const addr = getAddress(this.#server)
    this.#log('server listening on port ' + addr.port)
    await this.#dnssd.advertise(addr.port)
    this.#log('advertising service on port ' + addr.port)
  }

  /**
   *
   * @param {import('./dns-sd.js').MapeoService} service
   * @returns
   */
  #handleServiceUp({ address, port, name }) {
    this.#log('serviceUp', name.slice(0, 7), address, port)
    if (this.#noiseConnections.has(name)) {
      this.#log(`Already connected to ${name.slice(0, 7)}`)
      return
    }
    const socket = net.connect(port, address)
    socket.on('error', this.#handleSocketError)
    socket.once('connect', () => {
      this.#handleTcpConnection(true, socket)
    })
  }

  /**
   * @param {boolean} isInitiator
   * @param {net.Socket} socket
   */
  #handleTcpConnection(isInitiator, socket) {
    socket.off('error', this.#handleSocketError)
    socket.on('error', onSocketError)

    /** @param {any} e */
    function onSocketError(e) {
      if (e.code === 'EPIPE') {
        socket.destroy()
        if (secretStream) {
          secretStream.destroy()
        }
      }
    }

    const { remoteAddress } = socket
    if (!remoteAddress || !isPrivate(remoteAddress)) {
      socket.destroy(new Error('Invalid remoteAddress ' + remoteAddress))
      return
    }
    this.#log(
      `${isInitiator ? 'outgoing' : 'incoming'} tcp connection ${
        isInitiator ? 'to' : 'from'
      } ${remoteAddress}`
    )

    const secretStream = new NoiseSecretStream(isInitiator, socket, {
      keyPair: this.#identityKeypair,
    })

    secretStream.on('error', this.#handleSocketError)

    secretStream.on('connect', () => {
      // Further errors will be handled in #handleNoiseStreamConnection()
      socket.off('error', onSocketError)
      secretStream.off('error', this.#handleSocketError)
      this.#handleNoiseStreamConnection(
        // We know the NoiseStream is open at this point, so we can coerce the type
        /** @type {OpenedNoiseStream} */
        (secretStream)
      )
    })
  }

  /**
   *
   * @param {OpenedNoiseStream} existing
   * @param {OpenedNoiseStream} keeping
   */
  #handleConnectionSwap(existing, keeping) {
    let closed = false

    existing.on('close', () => {
      // The connection we are keeping could have closed before we get here
      if (closed) return

      keeping.removeListener('error', noop)
      keeping.removeListener('close', onclose)

      this.#handleNoiseStreamConnection(keeping)
    })

    keeping.on('error', noop)
    keeping.on('close', onclose)

    function onclose() {
      closed = true
    }
  }

  /**
   *
   * @param {OpenedNoiseStream} conn
   * @returns
   */
  #handleNoiseStreamConnection(conn) {
    const { remotePublicKey, isInitiator } = conn
    if (!remotePublicKey) {
      // Shouldn't get here
      this.#log('Error: incoming connection with no publicKey')
      conn.destroy()
      return
    }
    const remoteId = keyToPublicId(remotePublicKey)

    this.#log(
      `${isInitiator ? 'outgoing' : 'incoming'} secretSteam connection ${
        isInitiator ? 'to' : 'from'
      } %h`,
      remotePublicKey
    )

    const existing = this.#noiseConnections.get(remoteId)

    if (existing) {
      const keyCompare = Buffer.compare(
        this.#identityKeypair.publicKey,
        remotePublicKey
      )
      const keepExisting =
        // These first two checks check if a peer tried to connect twice. In
        // this case we keep the existing connection.
        (isInitiator && existing.isInitiator) ||
        (!isInitiator && !existing.isInitiator) ||
        // If each peer tried to connect to the other at the same time, then we
        // tie-break based on public key comparison (the initiator need to check
        // the opposite of the non-initiator, because the keys are the other way
        // around for them)
        (isInitiator ? keyCompare > 0 : keyCompare <= 0)
      if (keepExisting) {
        this.#log(`keeping existing, destroying new`)
        conn.on('error', noop)
        conn.destroy(new Error(ERR_DUPLICATE))
        return
      } else {
        this.#log(`destroying existing, keeping new`)
        existing.on('error', noop)
        existing.destroy(new Error(ERR_DUPLICATE))
        this.#handleConnectionSwap(existing, conn)
        return
      }
    }

    // Bail if the server has already stopped by this point. This should be
    // rare but can happen during connection swaps if the new connection is
    // "promoted" after the server's doors have already been closed.
    if (!this.#server.listening) {
      this.#log('server stopped, destroying connection %h', remotePublicKey)
      conn.destroy()
      return
    }

    this.#noiseConnections.set(remoteId, conn)

    conn.on('close', () => {
      this.#log('closed connection with %h', remotePublicKey)
      this.#noiseConnections.delete(remoteId)
    })

    // No 'error' listeners attached to `conn` at this point, it's up to the
    // consumer to attach an 'error' listener to avoid uncaught errors.
    this.emit('connection', conn)
  }

  get connections() {
    return this.#noiseConnections.values()
  }

  /**
   * Close all servers and stop multicast advertising and browsing. Will wait
   * for open sockets to close unless opts.force=true in which case open sockets
   * are force-closed after opts.timeout milliseconds
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] Force-close open sockets after timeout milliseconds
   * @param {number} [opts.timeout=0] Optional timeout when calling stop() with force=true
   * @returns {Promise<void>}
   */
  async stop(opts) {
    return this.#sm.stop(opts)
  }

  /**
   * @type {LocalDiscovery['stop']}
   */
  async #stop({ force = false, timeout = 0 } = {}) {
    this.#log('stopping')
    const { port } = getAddress(this.#server)
    this.#server.close()
    const destroyPromise = this.#dnssd.destroy()
    const closePromise = once(this.#server, 'close')
    await pTimeout(closePromise, {
      milliseconds: force ? (timeout === 0 ? 1 : timeout) : Infinity,
      fallback: () => {
        for (const socket of this.#noiseConnections.values()) {
          socket.destroy()
        }
        return pTimeout(closePromise, { milliseconds: 500 })
      },
    })
    await destroyPromise
    this.#log(`stopped for ${port}`)
  }
}

/**
 * Get the address of a server, will throw if the server is not yet listening or
 * if it is listening on a socket
 * @param {import('node:net').Server} server
 * @returns
 */
function getAddress(server) {
  const addr = server.address()
  if (addr === null || typeof addr === 'string') {
    throw new Error('Server is not listening on a port')
  }
  return addr
}
