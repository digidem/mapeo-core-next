// WARNING: Changing these will break things for existing apps, since namespaces
// are used for key derivation
export const NAMESPACES = /** @type {const} */ ([
  'auth',
  'config',
  'data',
  'blobIndex',
  'blob',
])

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

// WARNING: This value is persisted. Be careful when changing it.
export const DRIZZLE_MIGRATIONS_TABLE = '__mapeo_drizzle_migrations'
