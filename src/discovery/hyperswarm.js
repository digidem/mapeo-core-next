import { TypedEmitter } from 'tiny-typed-emitter'
import Hyperswarm from 'hyperswarm'

export class HyperswarmDiscovery extends TypedEmitter {
  #hyperswarm
  constructor() {
    super()
  }
  /**
   * @param {String} projectDiscoveryId
   * @returns {Promise<void>}
   */
  async join(projectDiscoveryId) {
    if (!this.#hyperswarm) {
      this.#hyperswarm = new Hyperswarm()
      const topic = Buffer.alloc(32).fill(projectDiscoveryId)
      this.#hyperswarm.join(topic, { server: false, client: true })
      // await this.#hyperswarm.flush()
      this.#hyperswarm.on('connection', (noiseStream, peerInfo) => {
        this.emit('connection', noiseStream, peerInfo)
      })
    }
  }

  /**
   * @param {String} projectDiscoveryId
   * @returns {Promise<void>}
   */
  async listen(projectDiscoveryId) {
    if (!this.#hyperswarm) {
      this.#hyperswarm = new Hyperswarm()
      const topic = Buffer.alloc(32).fill(projectDiscoveryId)
      const swarm = this.#hyperswarm.join(topic, {
        server: true,
        client: false,
      })
      await swarm.flushed()
      this.#hyperswarm.on('connection', (noiseStream, peerInfo) => {
        this.emit('connection', noiseStream, peerInfo)
      })
    }
  }

  leave() {}

  async stop() {
    const hyperswarm = this.#hyperswarm
    this.#hyperswarm = null
    this.removeAllListeners('connection')
    await hyperswarm.destroy()
  }
}
