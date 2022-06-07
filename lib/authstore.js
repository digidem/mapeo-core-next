import sodium from 'sodium-universal'

/**
 * @typedef {Object} OwnershipStatement
 * @property {string} key - unique id for this statement
 * @property {string} coreType - type of hypercore
 * @property {string} hypercorePublicKey - the hypercore where this statement was appended
 * @property {string} hypercoreSignature - signature for hypercorePublicKey
 * @property {string} identityPublicKey - the identity that this capability statement is about
 * @property {string} hypercoreSignature - signature for identityPublicKey
 */

/**
 * @typedef {Object} CapabilityStatement
 * @property {string} key - unique id for this statement
 * @property {string} hypercorePublicKey - the hypercore where this statement was appended
 * @property {string} identityPublicKey - the identity that this capability statement is about
 * @property {string} capability - capability changed by this statement
 * @property {string[]} links - links to previous statements about the identityPublicKey
 */

/**
 * @param {object} options
 * @param {object} options.store
 * @param {object} options.keyPair
 * @param {object} options.capabilities
*/
export class Authstore {
	#store
	#capabilitiesCore
	#identityKeyPair

	constructor ({ store, identityKeyPair, capabilities }) {
		this.#store = store
		this.#identityKeyPair = identityKeyPair
		this.capabilities = capabilities
	}

	/**
	 * @returns {Promise}
	 */
	async ready () {
		await this.#store.ready()

		try {
			const secretKey = this.#identityKeyPair.secretKey
			const publicKey = this.#identityKeyPair.publicKey

			this.#capabilitiesCore = this.#store.get({
				keyPair: this.#identityKeyPair,
				valueEncoding: 'json',
				auth: {
					sign (signable) {
						const signature = Buffer.allocUnsafe(sodium.crypto_sign_BYTES)
						sodium.crypto_sign_detached(signature, signable, secretKey)
						return signature
					},
					verify (signable, signature) {
						return sodium.crypto_sign_verify_detached(signature, signable, publicKey)
					}
				}
			})
		} catch (error) {
			console.error('capabilitiesCore error', error)
		}

		await this.#capabilitiesCore.ready()
		await this.appendOwnershipStatement()
	}

	/**
	 * @returns {Promise}
	 */
	async appendOwnershipStatement () {
		const hypercorePublicKey = this.#capabilitiesCore.key
		const hypercoreSignature = Buffer.alloc(sodium.crypto_sign_BYTES)
		const hypercoreSecretKey = this.#identityKeyPair.secretKey

		const identityPublicKey = this.#identityKeyPair.publicKey
		const identitySecretKey = this.#identityKeyPair.secretKey
		const identitySignature = Buffer.alloc(sodium.crypto_sign_BYTES)

		const messageToSign = Buffer.concat([hypercorePublicKey, identityPublicKey])
		sodium.crypto_sign_detached(identitySignature, messageToSign, identitySecretKey)
		sodium.crypto_sign_detached(hypercoreSignature, messageToSign, hypercoreSecretKey)

		const ownershipStatement = {
			key: this.createKey(),
			coreType: 'capabilities',
			hypercorePublicKey: hypercorePublicKey.toString('hex'),
			hypercoreSignature: hypercoreSignature.toString('hex'),
			identityPublicKey: identityPublicKey.toString('hex'),
			identitySignature: identitySignature.toString('hex'),
		}

		return this.#capabilitiesCore.append(ownershipStatement)
	}

	createKey () {
		const key = Buffer.alloc(32)
  	sodium.randombytes_buf(key)
		return key.toString('hex')
	}

	/**
	 * @returns {Promise}
	 */
	get () {
		return this.#store.get(...arguments)
	}

	replicate () {
		return this.#store.replicate(...arguments)
	}

	/**
	 * @returns {Promise}
	 */
	async getOwnershipStatement () {
		return this.#capabilitiesCore.get(0) // TODO: maybe some kind of validation this is the correct record
	}

	/**
	 * @returns {Map}
	 */
	get cores () {
		return this.#store.cores
	}

	/**
	 * @param {string} identityPublicKey
	 * @param {string} capability
	 * @returns {Promise<CapabilityStatement>}
	 */
	async append ({ identityPublicKey, capability }) {
		const capabilities = await this.getCapabilities()
		const lastStatement = capabilities[capabilities.length - 1]

		const statement = {
			key: this.createKey(),
			hypercorePublicKey: this.#capabilitiesCore.key.toString('hex'),
			identityPublicKey,
			capability,
			links: []
		}

		if (lastStatement) {
			statement.links.push(lastStatement.key)
		}

		await this.#capabilitiesCore.append(statement)
		return statement
	}

	/**
	 * @param {string} [identityPublicKey]
	 * @returns {Promise<CapabilityStatement[]>}
	 */
	async getUnorderedCapabilities (identityPublicKey) {
		let capabilities = []

		for (const [_, core] of this.#store.cores) {			
			for await (const buf of core.createReadStream()) {
				const data = JSON.parse(buf.toString())

				// only add to array if this is a CapabilityStatement and not an OwnershipStatement
				if (!data.coreType) {
					capabilities.push(data)
				}
			}
		}

		if (identityPublicKey) {
			return capabilities.filter((capability) => {
				return capability.identityPublicKey === identityPublicKey
			})
		}

		return capabilities
	}

	/**
	 * @returns {Promise<CapabilityStatement[]>}
	 */
	async getCapabilities () {
		const unordered = await this.getUnorderedCapabilities()
		const ordered = []

		// TODO: this ordering approach seems brittle
		for (const statement of unordered) {
			if (!statement.links.length) {
				ordered.unshift(statement)
			} else {
				const index = ordered.findIndex((item) => {
					return item.key === statement.links[0] // TODO: support multiple links
				})

				ordered.splice(index + 1, 0, statement)
			}
		}

		return ordered
	}

	/**
	 * @param {string} [identityPublicKey]
	 * @returns {CapabilityStatement}
	 */
	async resolveIdentityCapabilities (identityPublicKey) {
		const statements = await this.getCapabilities()
		let lowestCapability

		for (const statement of statements) {
			if (statement.identityPublicKey === identityPublicKey) {
				// get indexes of capabilities for comparison
				const capabilityIndex = this.capabilities.indexOf(statement.capability)
				const lowestCapabilityIndex = lowestCapability ? this.capabilities.indexOf(lowestCapability.capability) : -1

				// compare capability levels
				if (!lowestCapability || capabilityIndex < lowestCapabilityIndex) {
					lowestCapability = statement
				}
			}
		}

		// return lowest-level capability
		return lowestCapability
	}

	/**
	 * @returns {Boolean}
	 */
	async hasCapability ({ identityPublicKey, capability }) {
		const statement = await this.resolveIdentityCapabilities(identityPublicKey)
		const statementCapabilityIndex = this.capabilities.indexOf(statement.capability)
		const capabilityIndex = this.capabilities.indexOf(capability)
		return statementCapabilityIndex >= capabilityIndex
	}
}
