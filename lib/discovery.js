import { EventEmitter } from 'tiny-typed-emitter'
import Hyperswarm from 'hyperswarm'
import { LocalPeers } from './localpeers.js'

export class Discovery extends EventEmitter {
	#peers = new Map()

	#swarm
	#local

	constructor ({ identityKeyPair }) {
		super()

		this.#swarm = new Hyperswarm({ keyPair: identityKeyPair })
		this.#swarm.on('connection', this.onSwarmPeer.bind(this))

		this.#local = new LocalPeers({
			name: 'mapeo',
			identityKeyPair,
			onPeer: (peer) => {
				// TODO: use this as a way to dedupe
			}
		})

		this.#local.on('connection', this.onLocalPeer.bind(this))
	}

	onSwarmPeer (connection, info) {

	}

	onLocalPeer (connection, info) {

	}

	join (topic) {

	}

	leave (topic) {

	}

	destroy () {
		
	}
}
