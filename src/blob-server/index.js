import { once } from 'events'
import fastify from 'fastify'

import BlobServerPlugin from './fastify-plugin.js'

/**
 * @param {object} opts
 * @param {import('fastify').FastifyServerOptions['logger']} opts.logger
 * @param {import('../blob-store/index.js').BlobStore} opts.blobStore
 * @param {import('fastify').RegisterOptions['prefix']} opts.prefix
 * @param {string} opts.projectId Temporary option to enable `getBlobStore` option. Will be removed when multiproject support in Mapeo class is implemented.
 *
 */
export function createBlobServer({ logger, blobStore, prefix, projectId }) {
  const server = fastify({ logger })
  server.register(BlobServerPlugin, {
    getBlobStore: (projId) => {
      // Temporary measure until multiprojects is implemented in Mapeo class
      if (projectId !== projId) throw new Error('Project ID does not match')
      return blobStore
    },
    prefix,
  })
  return server
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<number>}
 */
export async function getPort(server) {
  const address = server.address()

  if (!address || !(typeof address === 'object') || !address.port) {
    await once(server, 'listening')
    return getPort(server)
  }

  return address.port
}
