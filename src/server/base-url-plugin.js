import createFastifyPlugin from 'fastify-plugin'

/** @type {import('fastify').FastifyPluginAsync<never>} */
const baseUrlPlugin = async function (fastify) {
  fastify.decorateRequest('baseUrl', null)
  fastify.addHook('onRequest', async function (req) {
    req.baseUrl = new URL(this.prefix, `${req.protocol}://${req.hostname}`)
  })
}

export default createFastifyPlugin(baseUrlPlugin, { name: 'baseUrl' })
