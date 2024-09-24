import NoiseSecretStream from '@hyperswarm/secret-stream'
import { once } from 'node:events'
import { createWebSocketStream, WebSocketServer } from 'ws'
import { MapeoManager } from '../mapeo-manager.js'
import { ExhaustivenessError } from '../utils.js'

export class MapeoCloudServer {
  #mapeoManager

  /**
   * @type {(
   *   { state: 'not started' } |
   *   { state: 'started'; websocketServer: WebSocketServer } |
   *   { state: 'stopped' }
   * )}
   */
  #websocketServer = { state: 'not started' }

  /**
   * @param {MapeoManager} mapeoManager
   */
  constructor(mapeoManager) {
    this.#mapeoManager = mapeoManager
  }

  /**
   * @param {object} options
   * @param {number} options.port
   * @returns {Promise<void>}
   */
  async listen({ port }) {
    switch (this.#websocketServer.state) {
      case 'not started': {
        const websocketServer = new WebSocketServer({ port })

        const isInitiator = false
        websocketServer.on('connection', (websocket) => {
          const websocketStream = createWebSocketStream(websocket)
          const secretStream = new NoiseSecretStream(
            isInitiator,
            websocketStream,
            { keyPair: this.#mapeoManager.getIdentityKeypair() }
          )
          MapeoManager.replicate(this.#mapeoManager, secretStream)
        })

        this.#websocketServer = { state: 'started', websocketServer }

        // TODO: Handle errors

        await once(websocketServer, 'listening')

        break
      }
      case 'started':
        throw new Error('Already listening')
      case 'stopped':
        throw new Error('Cannot restart')
      default:
        throw new ExhaustivenessError(this.#websocketServer)
    }
  }

  /**
   * Permanently close the websocket server.
   * @returns {Promise<void>}
   */
  async close() {
    switch (this.#websocketServer.state) {
      case 'not started':
        throw new Error('Server not started')
      case 'started': {
        const { websocketServer } = this.#websocketServer
        return new Promise((resolve, reject) => {
          websocketServer.close((err) => {
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
        })
      }
      case 'stopped':
        throw new Error('Already stopped')
      default:
        throw new ExhaustivenessError(this.#websocketServer)
    }
  }
}
