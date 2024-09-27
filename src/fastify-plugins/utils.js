import { once } from 'node:events'
import createError from '@fastify/error'

export const NotFoundError = createError(
  'FST_RESOURCE_NOT_FOUND',
  'Resource `%s` not found',
  404
)

/**
 * @param {import('node:http').Server} server
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<string>}
 */
export async function getFastifyServerAddress(server, { timeout } = {}) {
  const address = server.address()

  if (!address) {
    await once(server, 'listening', {
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    })
    return getFastifyServerAddress(server)
  }

  if (typeof address === 'string') {
    return address
  }

  // Full address construction for non unix-socket address
  // https://github.com/fastify/fastify/blob/7aa802ed224b91ca559edec469a6b903e89a7f88/lib/server.js#L413
  let addr = ''
  if (address.address.indexOf(':') === -1) {
    addr += address.address + ':' + address.port
  } else {
    addr += '[' + address.address + ']:' + address.port
  }

  return 'http://' + addr
}

/**
 * @param {Parameters<import('fastify').FastifyReply['headers']>[0]} [overrides]
 */
export function createStyleJsonResponseHeaders(overrides) {
  return {
    'Cache-Control': 'max-age=' + 5 * 60, // 5 minutes
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since',
    'Access-Control-Allow-Origin': '*',
    ...overrides,
  }
}
