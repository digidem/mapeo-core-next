import getPort from 'get-port';
import sodium from 'sodium-universal'

import { KeyManager, invites } from '@mapeo/crypto'

import { Authstore } from './authstore.js';
import { Datastore } from './datastore.js';
import { Discovery } from './discovery.js';

export class Project {
	#store
	#keyPair
	#identityKeyPair

	#datastores = new Map()

	/**
	 * @param {object} options
	 * @param {object} options.store - corestore instance
	 * @param {object} options.keyPair - key pair
	 * @param {object} options.keyPair.publicKey - public key
	 * @param {object} options.keyPair.secretKey - secret key
	 * @param {object} options.identityKeyPair - key pair
	 * @param {object} options.identityKeyPair.publicKey - public key
	 * @param {object} options.identityKeyPair.secretKey - secret key
	 * @param {object} options.capabilities - capabilities
	 */
	constructor ({ store, keyPair, identityKeyPair, port }) {
		this.#store = store
		this.#keyPair = keyPair
		this.#identityKeyPair = identityKeyPair
		this.key = keyPair.publicKey
		this.discoveryKey = this._getDiscoveryKey(keyPair.publicKey)
		this.port = port

		this.auth = new Authstore({
			store: this.#store.namespace('auth'),
			identityKeyPair,
			capabilities: ['none', 'member', 'admin']
		})
	}

	// TODO: move to mapeo-crypto
	_getDiscoveryKey(publicKey) {
    const digest = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(digest, Buffer.from('mapeo/alpha'), publicKey)
    return digest
  }

	async ready () {
		if (!this.port) {
			this.port = await getPort()
		}

		this.discovery = new Discovery({
			topic: this.discoveryKey,
			port: this.port,
			keyPair: this.#keyPair
		})
	}

	data (namespace) {
		let data = this.#datastores.get(namespace)

		if (data) {
			return data
		}

		data = new Datastore({
			store: this.#store.namespace(namespace)
		})

		this.#datastores.set(namespace, data)
		return data
	}
}
