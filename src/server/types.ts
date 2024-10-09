// This file should be read by Typescript and augments the FastifyInstance
// Unfortunately it does this globally, which is a limitation of fastify
// typescript support currently, so need to be careful about using this where it
// is not in scope.

import { type MapeoManager } from '../mapeo-manager.js'

declare module 'fastify' {
  interface FastifyInstance {
    comapeo: MapeoManager
  }
  interface FastifyRequest {
    baseUrl: URL
  }
}
