import { TypedEmitter } from 'tiny-typed-emitter'
import Hyperswarm from 'hyperswarm'

import { LocalPeers } from './localpeers.js'

export class Discovery extends TypedEmitter {
	#peers = new Map()
	#discover = new Map()
	#dht
	#mdns

	/**
	 * @param {object} options
	 * @param {Buffer} options.topic
	 * @param {number} options.port
	 * @param {object} options.identityKeyPair
	 * @param {Buffer} options.identityKeyPair.publicKey
	 * @param {Buffer} options.identityKeyPair.secretKey
	 * @param {boolean|object} [options.dht=true]
	 * @param {boolean|object} [options.mdns=true]
	 */
	constructor ({ identityKeyPair, topic, port, dht=true, mdns=true }) {
		super()

		this.topic = topic
		this.port = port

		if (dht !== false) {
			this.dhtOptions = typeof dht === 'object' ? dht : {}
			this.dhtOptions.keyPair = identityKeyPair

			this.#dht = new Hyperswarm(this.dhtOptions)
			this.#dht.on('connection', this._onDhtPeer.bind(this))
		}

		if (mdns) {
			const mdnsOptions = typeof mdns === 'object' ? mdns : {}
			mdnsOptions.keyPair = identityKeyPair
			mdnsOptions.port = port
			mdnsOptions.name = 'mapeo'

			this.#mdns = new LocalPeers(mdnsOptions)
			this.#mdns.on('connection', this._onMdnsPeer.bind(this))
		}
	}

	_onDhtPeer (connection, info) {
		const publicKey = connection.remotePublicKey.toString('hex')
		const peer = this.#peers.get(publicKey)

		if (!peer) {
			this.#peers.set(publicKey, {
				connection,
				info
			})

			this.emit('peer', connection, info, 'dht')
		} else {
			this.#dht.leavePeer(publicKey)
		}
	}

	_onMdnsPeer (connection, info) {
		const peer = this.#peers.get(info.identityPublicKey)

		if (!peer) {
			this.#peers.set(info.identityPublicKey, {
				connection,
				info
			})

			this.emit('peer', connection, info, 'mdns')
		} else {
			this.#mdns.leavePeer(this.topic, info.identityPublicKey)
		}
	}

	async join () {
		const topicString = this.topic.toString('hex')
		const discover = {}

		if (!this.#discover.has(topicString)) {
			if (this.#mdns) {
				discover.mdns = this.#mdns.join(this.topic)
			}

			if (this.#dht) {
				discover.dht = this.#dht.join(this.topic, {
					server: this.dhtOptions.server,
					client: this.dhtOptions.client
				})

				if (this.dhtOptions.server) {
					await discover.dht.flushed()
				} else {
					await this.#dht.flush()
				}
			}

			this.#discover.set(topicString, discover)
		}
	}

	async leave () {
		const topicString = this.topic.toString('hex')

		if (this.#dht) {
			await this.#dht.leave(this.topic)
		}

		if (this.#mdns) {
			this.#mdns.leave(this.topic)
		}

		if (this.#discover.has(topicString)) {
			const discover = this.#discover.get(topicString)

			if (discover.mdns) {
				discover.mdns.destroy()
			}

			if (discover.dht) {
				await discover.dht.destroy()
			}
		}
	}

	destroy () {
		if (this.#dht) {
			this.#dht.destroy()
		}

		if (this.#mdns) {
			this.#mdns.destroy()
		}
	}
}
