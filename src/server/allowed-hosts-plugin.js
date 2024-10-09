import createFastifyPlugin from 'fastify-plugin'

/**
 * @typedef {object} AllowedHostsPluginOptions
 * @property {string[]} [allowedHosts]
 */

/** @type {import('fastify').FastifyPluginAsync<AllowedHostsPluginOptions>} */
const comapeoPlugin = async function (fastify, { allowedHosts }) {
  if (!allowedHosts) {
    return
  }
  const allowedHostsSet = new Set(allowedHosts)
  fastify.addHook('onRequest', async function (req) {
    this.assert(allowedHostsSet.has(req.hostname), 403, 'Forbidden')
  })
}

export default createFastifyPlugin(comapeoPlugin, { name: 'allowedHosts' })
