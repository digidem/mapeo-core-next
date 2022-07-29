import { TypedEmitter } from 'tiny-typed-emitter'
import Hyperbee from 'hyperbee'
import mutexify from 'mutexify/promise.js'

// Create a shared set of hypercores with a materialized view of the data
// TODO: share all hypercores in the corestore, request cores from remote peers (it seems this might be best handled at the project level to share/request the cores of all datatypes in a project)
// TODO: persist hypercores
export class Datastore extends TypedEmitter {
	#corestore
	#keyPair
	#coresByKey = new Map()
	#coresByName = new Map()

	constructor ({ name, corestore, keyPair }) {
		super()
		this.name = name
		this.#keyPair = keyPair
		this.#corestore = corestore.namespace(`datastore/${name}`)
		this.status = 'instantiated'
		this.indexer = new Indexer({ name, corestore, indexKey: 'example' })
	}

	async ready () {
		await this.#corestore.ready()
		this.writer = await this.createWriter(this.name)
		this.status = 'ready'
	}

	async createWriter (name, options) {
		if (this.#coresByName.has(name)) {
			return this.#coresByName.get(name)
		}

		const core = this.#corestore.namespace(`core/${name}`).get(name)
		await this._setCore(name, core)
		return core
	}

	async cores () {
		return Array.from(this.#coresByKey.values())
	}

	async _setCore (name, core) {
		const key = core.key.toString('hex')

		if (this.#coresByKey.has(key)) {
			return
		}

		this.#coresByKey.set(key, core)
		this.#coresByName.set(name, core)
		this.emit('core', { name, key, core })

		core.on('append', () => {
			this.indexer.index(name, core)
		})

		core.on('download', () => {
			this.indexer.index(name, core)
		})
	}
}

// example indexer to be replaced
class Indexer extends TypedEmitter {
	constructor ({ corestore, name, indexKey, onIndexed = () => {} }) {
		this.corestore = corestore.namespace('index')
		this.core = this.corestore.get(name)
		this.db = new Hyperbee(this.core)
		this.staging = new Map()
		this.indexedSequence = 0
		this.indexKey = indexKey
		this.onIndexed = onIndexed
		this.indexLock = mutexify()
	}

	async ready () {
		await this.corestore.ready()
	}

	async index (core) {
		const release = await this.indexLock()
		await this._index(core)
		release()
	}

	async _index (core) {
		await this.stageBlocks(core)

		if (!this.#staging.size) {
			return
		}

		for (const data of this.#staging.values()) {
			// 👋 pretend we're determining a winner of forks here 👋
			await this.db.put(`${data[this.indexKey]}/`, data)
		}

		this.onIndexed()
	}

	async stageBlocks (core) {
		return new Promise ((resolve, reject) => {
			const stream = core.createReadStream({
				start: this.indexedSequence,
			})

			stream.on('data', (data) => {
				this.staging.set(data.key, data)
			})

			stream.on('end', () => {
				stream.destroy()
				resolve()
			})

			stream.on('error', (error) => {
				stream.destroy()
				reject(error)
			})
		})
	}
}
