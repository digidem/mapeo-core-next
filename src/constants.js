/** @import { Namespace } from './types.js' */

// WARNING: Changing these will break things for existing apps, since namespaces
// are used for key derivation
export const NAMESPACES = /** @type {const} */ ([
  'auth',
  'config',
  'data',
  'blobIndex',
  'blob',
])

/** @type {ReadonlyArray<Namespace>} */
export const PRESYNC_NAMESPACES = ['auth', 'config', 'blobIndex']

export const NAMESPACE_SCHEMAS = /** @type {const} */ ({
  data: ['observation', 'track'],
  config: [
    'translation',
    'preset',
    'field',
    'projectSettings',
    'deviceInfo',
    'icon',
  ],
  auth: ['coreOwnership', 'role'],
})

export const SUPPORTED_CONFIG_VERSION = 1
