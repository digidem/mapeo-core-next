import createServer from './app.js'
import envSchema from 'env-schema'
import { Type } from '@sinclair/typebox'
import path from 'node:path'
import fsPromises from 'node:fs/promises'
import crypto from 'node:crypto'

const DEFAULT_STORAGE = path.join(process.cwd(), 'data')
const CORE_DIR_NAME = 'core'
const DB_DIR_NAME = 'db'
const ROOT_KEY_FILE_NAME = 'root-key'

const schema = Type.Object({
  PORT: Type.Number({ default: 8080 }),
  SERVER_NAME: Type.String({
    description: 'name of the server',
    default: 'CoMapeo Server',
  }),
  SERVER_BEARER_TOKEN: Type.String({
    description:
      'Bearer token for accessing the server, can be any random string',
  }),
  STORAGE_DIR: Type.String({
    description: 'path to directory where data is stored',
    default: DEFAULT_STORAGE,
  }),
  ALLOWED_PROJECTS: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: 'number of projects allowed to join the server',
    })
  ),
})

/** @typedef {import('@sinclair/typebox').Static<typeof schema>} Env */
/** @type {ReturnType<typeof envSchema<Env>>} */
const config = envSchema({ schema, dotenv: true })

const coreStorage = path.join(config.STORAGE_DIR, CORE_DIR_NAME)
const dbFolder = path.join(config.STORAGE_DIR, DB_DIR_NAME)
const rootKeyFile = path.join(config.STORAGE_DIR, ROOT_KEY_FILE_NAME)
const projectMigrationsFolder = new URL(
  '../../drizzle/project',
  import.meta.url
).pathname
const clientMigrationsFolder = new URL('../../drizzle/client', import.meta.url)
  .pathname

await Promise.all([
  fsPromises.mkdir(coreStorage, { recursive: true }),
  fsPromises.mkdir(dbFolder, { recursive: true }),
])

/** @type {Buffer} */
let rootKey
try {
  rootKey = await fsPromises.readFile(rootKeyFile)
} catch (err) {
  if (
    typeof err === 'object' &&
    err &&
    'code' in err &&
    err.code !== 'ENOENT'
  ) {
    throw err
  }
  rootKey = crypto.randomBytes(16)
  await fsPromises.writeFile(rootKeyFile, rootKey)
}

if (!rootKey || rootKey.length !== 16) {
  throw new Error('Root key must be 16 bytes')
}

const fastify = createServer({
  serverName: config.SERVER_NAME,
  serverBearerToken: config.SERVER_BEARER_TOKEN,
  allowedProjects: config.ALLOWED_PROJECTS,
  rootKey,
  coreStorage,
  dbFolder,
  projectMigrationsFolder,
  clientMigrationsFolder,
  logger: true,
  trustProxy: true,
})

fastify.get('/healthcheck', async () => {})

try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

/** @param {NodeJS.Signals} signal*/
async function closeGracefully(signal) {
  console.log(`Received signal to terminate: ${signal}`)
  await fastify.close()
  console.log('Gracefully closed fastify')
  process.kill(process.pid, signal)
}
process.once('SIGINT', closeGracefully)
process.once('SIGTERM', closeGracefully)
