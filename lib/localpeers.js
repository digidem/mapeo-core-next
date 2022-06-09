import net from 'net'

import { TypedEmitter } from 'tiny-typed-emitter'
import { MdnsDiscovery } from 'mdns-sd-discovery'
import SecretStream from '@hyperswarm/secret-stream'

export class LocalPeers extends TypedEmitter {
	/**
	 * @type Map<string, MdnsPeerDiscovery>
	 */
	#discovery = new Map()

	/**
	 * @param {object} options
	 * @param {string} options.name
	 * @param {number} options.port
	 * @param {object} options.identityKeyPair
	 * @param {Buffer} options.identityKeyPair.publicKey
	 * @param {Buffer} options.identityKeyPair.secretKey
	 */
	constructor (options) {
		super()

		const {
			name,
			port,
			identityKeyPair
		} = options

		this.name = name
		this.port = port
		this.identityKeyPair = identityKeyPair
	}

	/**
	 * @param {Buffer} topic
	 * @returns {MdnsPeerDiscovery}
	 */
	join (topic) {
		const topicString = topic.toString('hex')
		let discovery = this.#discovery.get(topicString)

		if (discovery) {
			return discovery
		}

		discovery = new MdnsPeerDiscovery({
			topic: topicString,
			name: this.name,
			port: this.port,
			identityKeyPair: this.identityKeyPair
		})

		this.#discovery.set(topicString, discovery)
		return discovery
	}

	/**
	 * @param {Buffer} topic
	 * @returns {void}
	 */
	leave (topic) {
		const topicString = topic.toString('hex')

		if (!this.#discovery.has(topicString)) {
			return
		}

		const discovery = this.#discovery.get(topicString)

		if (discovery) {
			discovery.destroy()
		}

		this.#discovery.delete(topicString)
	}

	destroy () {
		this.#discovery.destroy()
	}
}

export class MdnsPeerDiscovery extends TypedEmitter {
	/**
	 * @type {MdnsDiscovery}
	 */
	#mdns

	/**
	 * @type import('net').Server
	 */
	#tcp = net.createServer()

	/**
	 * @type Map<string, MdnsPeerInfo>
	 */
	#peers = new Map()

	/**
	 * @type Map<string, import('net').Socket>
	 */
	#sockets = new Map()

	#identityKeyPair

	/**
	 * @param {object} options
	 * @param {string} options.name
	 * @param {number} options.port
	 * @param {string} options.topic
	 * @param {object} options.identityKeyPair
	 * @param {Buffer} options.identityKeyPair.publicKey
	 * @param {Buffer} options.identityKeyPair.secretKey
	 */
	constructor (options) {
		super()

		const {
			name,
			topic,
			port,
			identityKeyPair
		} = options

		this.#mdns = new MdnsDiscovery()
		this.#identityKeyPair = identityKeyPair

		this.topic = topic
		this.identityPublicKey = identityKeyPair.publicKey.toString('hex')

		this.#mdns.on('service', (service) => {
			if (
				service.txt
				&& service.txt.topic === topic
				&& service.txt.identity !== this.identityPublicKey
			) {
				const {
					host,
					port,
					txt
				} = service

				let peer = this.#peers.get(txt.identity)

				// TODO: what if a user's host and port change?
				// presumable they'd already have been removed from the peers list because they stopped peering
				if (!peer) {
					peer = new MdnsPeerInfo({
						host,
						port,
						topic: txt.topic,
						identityPublicKey: txt.identity
					})

					this.#peers.set(txt.identity, peer)
				}

				const socket = net.connect({
					host,
					port,
					allowHalfOpen: true
				})

				const stream = new SecretStream(true, socket, {
					keyPair: this.#identityKeyPair,
				})

				stream.on('connect', () => {
					this.emit('connection', stream, peer, 'net.connect')
				})

				stream.on('closed', () => {
					this.emit('connectionClosed', peer)
					this.#peers.delete(txt.identity)
					this.#sockets.delete(txt.identity)
				})

				this.#sockets.set(txt.identity, stream)
			}
		})

		this.#mdns.on('serviceDown', (service) => {
			if (
				service.txt
				&& service.txt.topic === topic
				&& service.txt.identity !== this.identityPublicKey
			) {
				const { txt } = service

				if (this.#peers.has(txt.identity)) {
					this.emit('connectionClosed', this.#peers.get(txt.identity))
					this.#peers.delete(txt.identity)
				}
			}
		})

		this.#tcp.listen({
			port
		}, () => {
			const address = this.#tcp.address()
			this.#mdns.announce(name, {
				port,
				host: address.address,
				txt: {
					identity: this.identityPublicKey,
					topic
				}
			})

			this.#tcp.on('connection', (socket) => {
				const address = socket.address()
				const stream = new SecretStream(false, socket)

				stream.on('connect', () => {
					const remotePublicKey = stream.remotePublicKey.toString('hex')
					let peer = this.#peers.get(remotePublicKey)

					if (!peer) {
						peer = new MdnsPeerInfo({
							host: address.address,
							port: address.port,
							topic: this.topic,
							identityPublicKey: remotePublicKey
						})
					}

					this.#peers.set(remotePublicKey, peer)
					this.#sockets.set(remotePublicKey, stream)
					this.emit('connection', stream, peer, 'tpc.on connection')
				})

				stream.on('close', () => {
					const remotePublicKey = stream.remotePublicKey.toString('hex')
					let peer = this.#peers.get(remotePublicKey)
					this.emit('connectionClosed', peer)
					this.#peers.delete(remotePublicKey)
					this.#sockets.delete(remotePublicKey)
				})
			})
		})

		this.#mdns.lookup(name)
	}

	get peers () {
		return Array.from(this.#peers.values())
	}

	destroy () {
		this.removeAllListeners('connection')
		this.removeAllListeners('connectionClosed')

		if (this.#mdns) {
			this.#mdns.destroy()
			this.#mdns.on('stopped', () => {
				this.#mdns = undefined

				for (const [key, socket] of this.#sockets.entries()) {
					socket.end()
				}

				if (this.#tcp) {
					this.#tcp.close()
					this.#tcp.on('close', () => {
						this.emit('destroyed')
						this.#tcp = undefined
					})
				}
			})
		}
	}
}

/**
 * @typdef {object}
 * @property {string} host
 * @property {number} number
 * @property {string} topic
 * @property {Buffer} identityPublicKey
 */
class MdnsPeerInfo {
	/**
	 * @param {object} options
	 * @param {string} options.host
	 * @param {number} options.port
	 * @param {string} options.topic
	 * @param {Buffer} options.identityPublicKey
	 */
	constructor (options) {
		const {
			host,
			port,
			topic,
			identityPublicKey
		} = options

		this.host = host
		this.port = port
		this.topic = topic
		this.identityPublicKey = identityPublicKey
	}
}
