
export class Authstore {
	#store

	constructor ({ store }) {
		this.#store = store
	}

	async ready () {
		await this.#store.ready()
	}

	get (options = {}) {
		return this.#store.get(options)
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
			return item.identityKey === publicKey && item.capability === 'admin'
		})

		return !!record
	}

	async isMember (publicKey) {
		const capabilities = await this.capabilities()

		const record = capabilities.find((item) => {
			return item.identityKey === publicKey && item.capability === 'member'
		})

		return !!record
	}
}
