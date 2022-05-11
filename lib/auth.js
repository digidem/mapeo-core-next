import sodium from 'sodium-universal'

export class Authstore {
	#store
	#capabilitiesCore
	#identityKeyPair

	constructor ({ store, keyPair }) {
		this.#store = store
		this.#identityKeyPair = keyPair
	}

	async ready () {
		await this.#store.ready()

		this.#capabilitiesCore = this.#store.get({
			keyPair: this.#identityKeyPair,
			valueEncoding: 'json'
		})

		await this.#capabilitiesCore.ready()
		await this.appendOwnershipStatement()
	}

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
			coreType: 'capabilities',
			hypercorePublicKey: hypercorePublicKey.toString('hex'),
			hypercoreSignature: hypercoreSignature.toString('hex'),
			identityPublicKey: identityPublicKey.toString('hex'),
			identitySignature: identitySignature.toString('hex'),
		}

		return this.#capabilitiesCore.append(ownershipStatement)
	}

	get () {
		return this.#store.get(...arguments)
	}

	replicate () {
		return this.#store.replicate(...arguments)
	}

	async getOwnershipStatement () {
		return this.#capabilitiesCore.get(0) // TODO: maybe some kind of validation this is the correct record
	}

	get cores () {
		return this.#store.cores
	}

	async capabilities () {
		const capabilities = []

		for (const [key, core] of this.#store.cores) {			
			for await (const data of core.createReadStream()) {
				capabilities.push({
					hypercoreKey: core.key.toString('hex'),
					...JSON.parse(data.toString())
				})
			}
		}

		return capabilities
	}

	async isAdmin (publicKey) {
		const capabilities = await this.capabilities()

		const record = capabilities.find((item) => {
			return item.identityPublicKey === publicKey && item.capability === 'admin'
		})

		return !!record
	}

	async isMember (publicKey) {
		const capabilities = await this.capabilities()

		const record = capabilities.find((item) => {
			return item.identityPublicKey === publicKey && item.capability === 'member'
		})

		return !!record
	}
}
