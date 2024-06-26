import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import fastify from 'fastify'

import IconServerPlugin from '../../src/fastify-plugins/icons.js'
import { projectKeyToPublicId } from '../../src/utils.js'

test('Plugin throws error if missing getProject option', async () => {
  const server = fastify()
  await assert.rejects(async () => {
    await server.register(IconServerPlugin)
  })
})

test('Plugin handles prefix option properly', async () => {
  const prefix = 'icons'

  const server = fastify()

  server.register(IconServerPlugin, {
    prefix,
    getProject: async () => {
      throw new Error('Not implemented')
    },
  })

  const response = await server.inject({
    method: 'GET',
    url: `${prefix}/${buildIconUrl({
      projectPublicId: projectKeyToPublicId(randomBytes(32)),
      iconId: randomBytes(32).toString('hex'),
      size: 'small',
      extension: 'png',
    })}`,
  })

  assert.notEqual(response.statusCode, 404, 'returns non-404 status code')
})

test('url param validation', async () => {
  const server = fastify()

  server.register(IconServerPlugin, {
    getProject: async () => {
      throw new Error('Not implemented')
    },
  })

  const projectPublicId = projectKeyToPublicId(randomBytes(32))
  const iconId = randomBytes(32).toString('hex')

  /** @type {Array<[string, Parameters<typeof buildIconUrl>[0]]>} */
  const fixtures = [
    [
      'invalid project public id',
      {
        projectPublicId: randomBytes(32).toString('hex'),
        iconId,
        size: 'small',
        extension: 'png',
      },
    ],
    [
      'invalid icon id',
      {
        projectPublicId,
        iconId: randomBytes(16).toString('hex'),
        size: 'small',
        extension: 'png',
      },
    ],
    [
      'invalid pixel density',
      {
        projectPublicId,
        iconId,
        size: 'small',
        extension: 'png',
        pixelDensity: 10,
      },
    ],
    [
      'invalid size',
      {
        projectPublicId,
        iconId,
        size: 'foo',
        extension: 'svg',
      },
    ],
    [
      'invalid extension',
      {
        projectPublicId,
        iconId,
        size: 'small',
        extension: 'foo',
      },
    ],
  ]

  await Promise.all(
    fixtures.map(async ([_, input]) => {
      const response = await server.inject({
        method: 'GET',
        url: buildIconUrl(input),
      })

      assert.equal(response.statusCode, 400, 'returns expected status code')
      assert.equal(
        response.json().code,
        'FST_ERR_VALIDATION',
        'error is validation error'
      )
    })
  )
})

/**
 *
 * @param {object} opts
 * @param {string} opts.projectPublicId
 * @param {string} opts.iconId
 * @param {string} opts.size
 * @param {number} [opts.pixelDensity]
 * @param {string} opts.extension
 *
 * @returns {string}
 */
function buildIconUrl({
  projectPublicId,
  iconId,
  size,
  pixelDensity,
  extension,
}) {
  const densitySuffix =
    typeof pixelDensity === 'number' ? `@${pixelDensity}x` : ''
  return `${projectPublicId}/${iconId}/${size}${densitySuffix}.${extension}`
}
