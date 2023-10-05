import { parseVersionId } from '@mapeo/schema'
import { Type as T } from '@sinclair/typebox'
import fp from 'fastify-plugin'
import { kDataTypes, kCoreManager } from '../mapeo-project.js'

export default fp(iconServerPlugin, {
  fastify: '4.x',
  name: 'mapeo-icon-server',
})

// const HEX_REGEX_32_BYTES = '^[0-9a-fA-F]{64}$'
// const HEX_REGEX_26_BYTES = '^[0-9a-fA-F]{52}$'
const HEX_STRING_32_BYTES = T.String({})
const HEX_STRING_26_BYTES = T.String({})
const PARAMS_JSON_SCHEMA = T.Object({
  iconDocId: HEX_STRING_32_BYTES,
  projectId: HEX_STRING_26_BYTES,
  size: T.String(),
  pixelDensity: T.Number(),
})

/**
 * @typedef {Object} IconServerPluginOpts
 * @property {import('fastify').RegisterOptions['prefix']} prefix
 * @property {(projectId: string) => Promise<import('../mapeo-project.js').MapeoProject>} getProject
 **/

/** @type {import('fastify').FastifyPluginAsync<import('fastify').RegisterOptions & IconServerPluginOpts>} */
async function iconServerPlugin(fastify, options) {
  fastify.register(routes, options)
}

/** @type {import('fastify').FastifyPluginAsync<
 * Omit<IconServerPluginOpts, 'prefix'>,
 * import('fastify').RawServerDefault,
 * import('@fastify/type-provider-typebox').TypeBoxTypeProvider>} */
async function routes(fastify, options) {
  const { getProject } = options

  fastify.get(
    '/:projectId/:iconDocId/:size/:pixelDensity',
    { schema: { params: PARAMS_JSON_SCHEMA } },
    async (req, res) => {
      const { projectId, iconDocId, size, pixelDensity } = req.params
      const project = await getProject(projectId)
      const iconDataType = project[kDataTypes].icon
      const coreManager = project[kCoreManager]
      const icon = await iconDataType.getByDocId(iconDocId)
      const bestVariant = findBestVariantMatch(icon.variants, {
        size,
        pixelDensity,
      })
      const { coreDiscoveryKey, index } = parseVersionId(
        bestVariant.blobVersionId
      )
      const core = coreManager.getCoreByDiscoveryKey(coreDiscoveryKey)
      res.headers({ 'mime-type': bestVariant.mimeType })
      if (core) {
        const blob = core.get(index)
        return res.send(blob)
      } else {
        return res.code(404)
      }
    }
  )
}

/**
 * @param {import('@mapeo/schema').IconValue['variants']} variants
 * @param {object} opts
 * @param {string} opts.size
 * @param {number} opts.pixelDensity
 **/
function findBestVariantMatch(variants, { size, pixelDensity }) {
  console.log(size, pixelDensity)
  return variants[0]
}
