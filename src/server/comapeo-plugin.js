import { MapeoManager } from '../mapeo-manager.js'
import createFastifyPlugin from 'fastify-plugin'

/**
 * @typedef {Omit<ConstructorParameters<typeof MapeoManager>[0], 'fastify'>} ComapeoPluginOptions
 */

/** @type {import('fastify').FastifyPluginAsync<ComapeoPluginOptions>} */
const comapeoPlugin = async function (fastify, opts) {
  const comapeo = new MapeoManager({ ...opts, fastify })
  fastify.decorate('comapeo', comapeo)
}

export default createFastifyPlugin(comapeoPlugin, { name: 'comapeo' })
