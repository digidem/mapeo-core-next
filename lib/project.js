import { Authstore } from './authstore.js';
import { Datastore } from './datastore.js';
import { Discovery } from './discovery.js';

export class Project {
	#store
	#identityKeyPair

	/**
	 * @param {object} options
	 * @param {object} options.store - corestore instance
	 * @param {object} options.identityKeyPair - identity key pair
	 * @param {object} options.identityKeyPair.publicKey - public key
	 * @param {object} options.identityKeyPair.secretKey - secret key
	 * @param {object} options.capabilities - capabilities
	 */
	constructor ({ store, identityKeyPair }) {
		this.#store = store
		this.#identityKeyPair = identityKeyPair

		this.discovery = new Discovery({

		})

		this.auth = new Authstore({
			store: this.#store.namespace('authstore'),
			identityKeyPair,
			capabilities: ['none', 'member', 'admin']
		})

		this.data = new Datastore({
			store: this.#store.namespace('data'),
		})
	}
}
