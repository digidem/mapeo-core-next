import { valueOf } from '@comapeo/schema'
import { KeyManager } from '@mapeo/crypto'
import { generate } from '@mapeo/mock-data'
import assert from 'node:assert/strict'
import crypto, { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import test from 'node:test'
import createServer from '../src/server/app.js'
import { projectKeyToPublicId } from '../src/utils.js'
import { blobMetadata } from '../test/helpers/blob-store.js'
import { createManager, getManagerOptions } from './utils.js'
import { map } from 'iterpal'
/** @import { ObservationValue } from '@comapeo/schema'*/
/** @import { FastifyInstance } from 'fastify' */

// TODO: Dynamically choose a port that's open
const PORT = 9875
const BASE_URL = `http://localhost:${PORT}/`
const BEARER_TOKEN = Buffer.from('swordfish').toString('base64')
const FIXTURES_ROOT = new URL('../src/server/test/fixtures/', import.meta.url)
const FIXTURE_ORIGINAL_PATH = new URL('original.jpg', FIXTURES_ROOT).pathname
const FIXTURE_PREVIEW_PATH = new URL('preview.jpg', FIXTURES_ROOT).pathname
const FIXTURE_THUMBNAIL_PATH = new URL('thumbnail.jpg', FIXTURES_ROOT).pathname

test('server info endpoint', async (t) => {
  const serverName = 'test server'
  const server = createTestServer(t, serverName)
  const expectedResponseBody = {
    data: {
      deviceId: server.deviceId,
      name: serverName,
    },
  }
  const response = await server.inject({
    method: 'GET',
    url: '/info',
  })
  assert.deepEqual(response.json(), expectedResponseBody)
})

test('add project, sync endpoint available', async (t) => {
  const server = createTestServer(t)
  const projectKeys = randomProjectKeys()
  const projectPublicId = projectKeyToPublicId(
    Buffer.from(projectKeys.projectKey, 'hex')
  )

  await t.test('add project', async () => {
    const expectedResponseBody = {
      data: {
        deviceId: server.deviceId,
      },
    }
    const response = await server.inject({
      method: 'POST',
      url: '/projects',
      body: projectKeys,
    })
    assert.deepEqual(response.json(), expectedResponseBody)
  })

  await t.test('sync endpoint available', async (t) => {
    const ws = await server.injectWS('/sync/' + projectPublicId)
    t.after(() => ws.terminate())
    assert.equal(ws.readyState, ws.OPEN, 'websocket is open')
  })
})

test('no project added, sync endpoint not available', async (t) => {
  const server = createTestServer(t)

  const projectPublicId = projectKeyToPublicId(randomBytes(32))

  const response = await server.inject({
    method: 'GET',
    url: '/sync/' + projectPublicId,
    headers: {
      connection: 'upgrade',
      upgrade: 'websocket',
    },
  })
  assert.equal(response.statusCode, 404)
  assert.equal(response.json().error, 'Not Found')
})

test('invalid project public id', async (t) => {
  const server = createTestServer(t)

  const response = await server.inject({
    method: 'GET',
    url: '/sync/foobidoobi',
    headers: {
      connection: 'upgrade',
      upgrade: 'websocket',
    },
  })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().code, 'FST_ERR_VALIDATION')
})

test('trying to add second project fails', async (t) => {
  const server = createTestServer(t)

  await t.test('add first project', async () => {
    const expectedResponseBody = {
      data: {
        deviceId: server.deviceId,
      },
    }
    const response = await server.inject({
      method: 'POST',
      url: '/projects',
      body: randomProjectKeys(),
    })
    assert.deepEqual(response.json(), expectedResponseBody)
  })

  await t.test('attempt to add second project', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/projects',
      body: randomProjectKeys(),
    })
    assert.equal(response.statusCode, 403)
  })
})

test('observations endpoint', async (t) => {
  const server = createTestServer(t)

  const serverBaseUrl = await server.listen({ port: PORT })
  t.after(() => server.close())

  const manager = await createManager('client', t)
  const projectId = await manager.createProject()
  const project = await manager.getProject(projectId)

  await project.$member.addServerPeer(serverBaseUrl, {
    dangerouslyAllowInsecureConnections: true,
  })

  await t.test('returns a 403 if no auth is provided', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/observations`,
    })
    assert.equal(response.statusCode, 403)
  })

  await t.test('returns a 403 if incorrect auth is provided', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/observations`,
      headers: { Authorization: 'Bearer bad' },
    })
    assert.equal(response.statusCode, 403)
  })

  await t.test('no observations', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}/observations`,
      headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(await response.json(), { data: [] })
  })

  await t.test(
    'returning observations with fetchable attachments',
    async () => {
      project.$sync.start()
      project.$sync.connectServers()

      const observations = await Promise.all([
        (() => {
          /** @type {ObservationValue} */
          const noAttachments = {
            ...valueOf(generate('observation')[0]),
            attachments: [],
          }
          return project.observation.create(noAttachments)
        })(),
        (async () => {
          const blob = await project.$blobs.create(
            {
              original: FIXTURE_ORIGINAL_PATH,
              preview: FIXTURE_PREVIEW_PATH,
              thumbnail: FIXTURE_THUMBNAIL_PATH,
            },
            blobMetadata({ mimeType: 'image/jpeg' })
          )
          /** @type {ObservationValue} */
          const withAttachment = {
            ...valueOf(generate('observation')[0]),
            attachments: [blobToAttachment(blob)],
          }
          return project.observation.create(withAttachment)
        })(),
      ])

      await project.$sync.waitForSync('full')

      const response = await server.inject({
        method: 'GET',
        url: `/projects/${projectId}/observations`,
        headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
      })

      assert.equal(response.statusCode, 200)

      const { data } = await response.json()

      assert.equal(data.length, 2)

      await Promise.all(
        observations.map(async (observation) => {
          const observationFromApi = data.find(
            (/** @type {{ docId: string }} */ o) =>
              o.docId === observation.docId
          )
          assert(observationFromApi, 'observation found in API response')
          assert.equal(observationFromApi.createdAt, observation.createdAt)
          assert.equal(observationFromApi.updatedAt, observation.updatedAt)
          assert.equal(observationFromApi.lat, observation.lat)
          assert.equal(observationFromApi.lon, observation.lon)
          await assertAttachmentsCanBeFetched({ server, observationFromApi })
        })
      )
    }
  )
})

function randomHexKey(length = 32) {
  return Buffer.from(crypto.randomBytes(length)).toString('hex')
}

function randomProjectKeys() {
  return {
    projectKey: randomHexKey(),
    encryptionKeys: {
      auth: randomHexKey(),
      config: randomHexKey(),
      data: randomHexKey(),
      blobIndex: randomHexKey(),
      blob: randomHexKey(),
    },
  }
}

/**
 *
 * @param {import('node:test').TestContext} t
 * @returns {ReturnType<typeof createServer> & { deviceId: string }}
 */
function createTestServer(t, serverName = 'test server') {
  const managerOptions = getManagerOptions(serverName)
  const km = new KeyManager(managerOptions.rootKey)
  const server = createServer({
    ...managerOptions,
    serverName,
    serverPublicBaseUrl: 'http://localhost:' + PORT,
    serverBearerToken: BEARER_TOKEN,
  })
  t.after(() => server.close())
  Object.defineProperty(server, 'deviceId', {
    get() {
      return km.getIdentityKeypair().publicKey.toString('hex')
    },
  })
  // @ts-expect-error
  return server
}

/**
 * TODO: Use a better type for `blob.type`
 * @param {object} blob
 * @param {string} blob.driveId
 * @param {any} blob.type
 * @param {string} blob.name
 * @param {string} blob.hash
 */
function blobToAttachment(blob) {
  return {
    driveDiscoveryId: blob.driveId,
    type: blob.type,
    name: blob.name,
    hash: blob.hash,
  }
}

/**
 * @param {object} options
 * @param {FastifyInstance} options.server
 * @param {Record<string, unknown>} options.observationFromApi
 * @returns {Promise<void>}
 */
async function assertAttachmentsCanBeFetched({ server, observationFromApi }) {
  assert(Array.isArray(observationFromApi.attachments))
  await Promise.all(
    observationFromApi.attachments.map(
      /** @param {unknown} attachment */
      async (attachment) => {
        assert(attachment && typeof attachment === 'object')
        assert('url' in attachment && typeof attachment.url === 'string')
        await assertAttachmentAndVariantsCanBeFetched(server, attachment.url)
      }
    )
  )
}

/**
 * @param {FastifyInstance} server
 * @param {string} url
 * @returns {Promise<void>}
 */
async function assertAttachmentAndVariantsCanBeFetched(server, url) {
  assert(url.startsWith(BASE_URL))

  /** @type {Map<null | string, string>} */
  const variantsToCheck = new Map([
    [null, FIXTURE_ORIGINAL_PATH],
    ['original', FIXTURE_ORIGINAL_PATH],
    ['preview', FIXTURE_PREVIEW_PATH],
    ['thumbnail', FIXTURE_THUMBNAIL_PATH],
  ])

  await Promise.all(
    map(variantsToCheck, async ([variant, fixturePath]) => {
      const expectedResponseBodyPromise = fs.readFile(fixturePath)
      const attachmentResponse = await server.inject({
        method: 'GET',
        url: url + (variant ? `?variant=${variant}` : ''),
        headers: { Authorization: 'Bearer ' + BEARER_TOKEN },
      })
      assert.equal(
        attachmentResponse.statusCode,
        200,
        `expected 200 when fetching ${variant} attachment`
      )
      assert.equal(
        attachmentResponse.headers['content-type'],
        'image/jpeg',
        `expected ${variant} attachment to be a JPEG`
      )
      assert.deepEqual(
        attachmentResponse.rawPayload,
        await expectedResponseBodyPromise,
        `expected ${variant} attachment to match fixture`
      )
    })
  )
}
