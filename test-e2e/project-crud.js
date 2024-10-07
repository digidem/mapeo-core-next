import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import { ExhaustivenessError, valueOf } from '../src/utils.js'
import {
  createManager,
  sortById,
  removeUndefinedFields,
  randomBool,
  randomDate,
  randomNum,
} from './utils.js'
import { round } from './utils.js'
import { generate } from '@mapeo/mock-data'
import { setTimeout as delay } from 'timers/promises'
/**
 * @import {
 *   FieldValue,
 *   MapeoDoc,
 *   ObservationValue,
 *   PresetValue,
 *   RemoteDetectionAlertValue,
 *   TrackValue,
 * } from '@comapeo/schema' */
/** @import { MapeoProject } from '../src/mapeo-project.js' */

/** @type {Array<FieldValue | ObservationValue | PresetValue | RemoteDetectionAlertValue | TrackValue>} */
const fixtures = [
  {
    schemaName: 'observation',
    lat: -3,
    lon: 37,
    tags: {},
    attachments: [],
    metadata: { manualLocation: false },
  },
  {
    schemaName: 'preset',
    name: 'myPreset',
    tags: {},
    iconRef: {
      docId: randomBytes(32).toString('hex'),
      versionId: `${randomBytes(32).toString('hex')}/0`,
    },
    geometry: ['point'],
    addTags: {},
    removeTags: {},
    fieldRefs: [],
    terms: [],
    color: '#ff00ff',
  },
  {
    schemaName: 'field',
    type: 'text',
    tagKey: 'foo',
    label: 'my label',
    universal: false,
  },
  {
    schemaName: 'track',
    observationRefs: [],
    tags: {},
    locations: Array.from({ length: 10 }, trackPositionFixture),
  },
  {
    schemaName: 'remoteDetectionAlert',
    detectionDateStart: new Date().toISOString(),
    detectionDateEnd: new Date().toISOString(),
    sourceId: randomBytes(32).toString('hex'),
    metadata: { alert_type: 'fire' },
    geometry: {
      type: 'Point',
      coordinates: [-3, 37],
    },
  },
]

/**
 * Create a doc for this test.
 *
 * Only supports the schema names we use in this test file, but should be easy
 * to extend if we add new ones.
 *
 * This function has a bunch of repeated code. In a perfect world, we wouldn't
 * need to do this. Instead, we'd just do:
 *
 *     project[value.schemaName].create(value)
 *
 * Unfortunately, this doesn't type check because each schema name's `create`
 * function is incompatible with the others. See [this TypeScript playground][0]
 * for a minimal reproduction of this problem.
 *
 * [0]: https://www.typescriptlang.org/play/?#code/JYOwLgpgTgZghgYwgAgGIHt3IN4ChnIyYBcyIArgLYBG0A3LgL666iSyIoBCcUO+yar1IUa9JiwToQAZzDIANugDmy6MgC8-AkXSkAPABVkEAB6QQAExlpMAPgAUANzgLyEUoYCUmu8imy6AoQAHRKys6u7iG6XgA0AkJQBsZmFtbIPFCOLm4eyN6+-tIyQaHhkXkhSfFMDLgBcsjoAA5gwCWayADaAES6vXHIvUm9ALrIcDaNYAxEfA4zzW0dIM0wy+0lPngES+jUAFakGFgAPpm8Xa1baxr3wwPIAPw4hCTIAIzIjMik2IJhMgAEw-BgEcJqKDdG6rMYOA6HLwMRhAA
 *
 * @param {MapeoProject} project
 * @param {FieldValue | ObservationValue | PresetValue | TrackValue | RemoteDetectionAlertValue} value
 * @returns {Promise<MapeoDoc>}
 */
function create(project, value) {
  switch (value.schemaName) {
    case 'field':
      return project[value.schemaName].create(value)
    case 'observation':
      return project[value.schemaName].create(value)
    case 'preset':
      return project[value.schemaName].create(value)
    case 'remoteDetectionAlert':
      return project[value.schemaName].create(value)
    case 'track':
      return project[value.schemaName].create(value)
    default:
      throw new ExhaustivenessError(value)
  }
}

/**
 * Create a bunch of docs with mocked data. See above for why this function exists.
 *
 * @param {MapeoProject} project
 * @param {'field' | 'observation' | 'preset' | 'track' | 'remoteDetectionAlert'} schemaName
 * @param {number} count
 * @returns {Promise<MapeoDoc[]>}
 */
function createWithMockData(project, schemaName, count) {
  switch (schemaName) {
    case 'field':
      return Promise.all(
        generate(schemaName, { count }).map((doc) =>
          project[schemaName].create(valueOf(doc))
        )
      )
    case 'observation':
      return Promise.all(
        generate(schemaName, { count }).map((doc) =>
          project[schemaName].create(valueOf(doc))
        )
      )
    case 'preset':
      return Promise.all(
        generate(schemaName, { count }).map((doc) =>
          project[schemaName].create(valueOf(doc))
        )
      )
    case 'remoteDetectionAlert':
      // TODO: Add support for remoteDetectionAlert in mapeo-mock-data
      return Promise.all(
        Array(count)
          .fill(null)
          .map(() =>
            project[schemaName].create({
              schemaName: 'remoteDetectionAlert',
              detectionDateStart: new Date().toISOString(),
              detectionDateEnd: new Date().toISOString(),
              sourceId: randomBytes(32).toString('hex'),
              metadata: { alert_type: 'fire' },
              geometry: {
                type: 'Point',
                coordinates: [-3, 37],
              },
            })
          )
      )
    case 'track':
      return Promise.all(
        generate(schemaName, { count }).map((doc) =>
          project[schemaName].create(valueOf(doc))
        )
      )
    default:
      throw new ExhaustivenessError(schemaName)
  }
}

/**
 * Update a doc. See above for why this function exists.
 *
 * @param {MapeoProject} project
 * @param {string} versionId
 * @param {FieldValue | ObservationValue | PresetValue | TrackValue | RemoteDetectionAlertValue} value
 * @returns {Promise<MapeoDoc>}
 */
function update(project, versionId, value) {
  switch (value.schemaName) {
    case 'field':
      return project[value.schemaName].update(versionId, value)
    case 'observation':
      return project[value.schemaName].update(versionId, value)
    case 'preset':
      return project[value.schemaName].update(versionId, value)
    case 'remoteDetectionAlert':
      return project[value.schemaName].update(versionId, value)
    case 'track':
      return project[value.schemaName].update(versionId, value)
    default:
      throw new ExhaustivenessError(value)
  }
}

/**
 * Add some random data to each fixture to test updates
 *
 * @template {import('@comapeo/schema').MapeoValue} T
 * @param {T} value
 * @returns {T}
 */
function getUpdateFixture(value) {
  switch (value.schemaName) {
    case 'observation':
      return {
        ...value,
        lon: round(Math.random() * 180, 6),
        lat: round(Math.random() * 90, 6),
      }
    case 'preset':
      return {
        ...value,
        fieldRefs: [
          {
            docId: randomBytes(32).toString('hex'),
            versionId: `${randomBytes(32).toString('hex')}/0`,
          },
        ],
      }
    case 'field':
      return {
        ...value,
        label: randomBytes(10).toString('hex'),
      }
    case 'remoteDetectionAlert':
      return { ...value }
    case 'track':
      return {
        ...value,
        tags: {
          foo: 'bar',
        },
      }
    default:
      return { ...value }
  }
}

const CREATE_COUNT = 100

test('CRUD operations', async (t) => {
  const manager = createManager('device0', t)

  for (const value of fixtures) {
    const { schemaName } = value
    await t.test(`create and read ${schemaName}`, async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      /** @type {MapeoDoc[]} */
      const updates = []
      project[schemaName].on('updated-docs', (docs) => updates.push(...docs))
      const written = await createWithMockData(
        project,
        schemaName,
        CREATE_COUNT
      )
      const read = await Promise.all(
        written.map((doc) => project[schemaName].getByDocId(doc.docId))
      )
      assert.deepEqual(
        sortById(written),
        sortById(read),
        'return create() matches return of getByDocId()'
      )
      assert.deepEqual(
        sortById(updates),
        sortById(written),
        'updated-docs emitted'
      )
    })
    await t.test('update', async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      const written = await create(project, value)
      const updateValue = getUpdateFixture(value)
      await delay(1) // delay to ensure updatedAt is different to createdAt
      const updated = await update(project, written.versionId, updateValue)
      const updatedReRead = await project[schemaName].getByDocId(written.docId)
      assert.deepEqual(
        updated,
        updatedReRead,
        'return of update() matched return of getByDocId()'
      )
      assert.deepEqual(
        valueOf(removeUndefinedFields(updated)),
        updateValue,
        'expected value is updated'
      )
      assert.notEqual(
        written.updatedAt,
        updated.updatedAt,
        'updatedAt has changed'
      )
      assert.equal(
        written.createdAt,
        updated.createdAt,
        'createdAt does not change'
      )
      assert.equal(
        written.originalVersionId,
        updated.originalVersionId,
        'originalVersionId does not change'
      )
    })
    await t.test('getMany', async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      const written = await createWithMockData(
        project,
        schemaName,
        CREATE_COUNT
      )
      const expectedWithoutDeleted = []
      const deletePromises = []
      for (const [i, doc] of written.entries()) {
        // delete every 3rd doc
        if (i % 3 === 0) {
          deletePromises.push(project[schemaName].delete(doc.docId))
        } else {
          expectedWithoutDeleted.push(doc)
        }
      }
      const deleted = await Promise.all(deletePromises)
      const expectedWithDeleted = [...expectedWithoutDeleted, ...deleted]
      const manyWithoutDeleted = await project[schemaName].getMany()
      assert.deepEqual(
        sortById(manyWithoutDeleted),
        sortById(expectedWithoutDeleted),
        'expected values returns from getMany()'
      )
      const manyWithDeleted = await project[schemaName].getMany({
        includeDeleted: true,
      })
      assert.deepEqual(
        sortById(manyWithDeleted),
        sortById(expectedWithDeleted),
        'expected values returns from getMany({ includeDeleted: true })'
      )
    })

    await t.test('create, close and then create, update', async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      const values = new Array(5).fill(null).map(() => {
        return getUpdateFixture(value)
      })
      for (const value of values) {
        await create(project, value)
      }
      const written = await create(project, value)
      await project.close()

      await assert.rejects(async () => {
        const updateValue = getUpdateFixture(value)
        await update(project, written.versionId, updateValue)
      }, 'should fail updating since the project is already closed')

      await assert.rejects(async () => {
        for (const value of values) {
          await create(project, value)
        }
      }, 'should fail creating since the project is already closed')

      await assert.rejects(async () => {
        await project[schemaName].getMany()
      }, 'should fail getting since the project is already closed')
    })

    await t.test('create, read, close, re-open, read', async () => {
      const projectId = await manager.createProject()

      let project = await manager.getProject(projectId)

      const values = new Array(5).fill(null).map(() => {
        return getUpdateFixture(value)
      })

      for (const value of values) {
        await create(project, value)
      }

      const many1 = await project[schemaName].getMany()
      const manyValues1 = many1.map((doc) => valueOf(doc))

      // close it
      await project.close()

      // re-open project
      project = await manager.getProject(projectId)

      const many2 = await project[schemaName].getMany()
      const manyValues2 = many2.map((doc) => valueOf(doc))

      assert.deepEqual(
        removeUndefinedFields(manyValues1),
        removeUndefinedFields(manyValues2),
        'expected values returned before closing and after re-opening'
      )
    })

    await t.test(`create and delete ${schemaName}`, async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      const written = await createWithMockData(
        project,
        schemaName,
        CREATE_COUNT
      )
      const deleted = await Promise.all(
        written.map((doc) => project[schemaName].delete(doc.docId))
      )
      const read = await Promise.all(
        written.map((doc) => project[schemaName].getByDocId(doc.docId))
      )
      assert(
        deleted.every((doc) => doc.deleted),
        'all docs are deleted'
      )
      assert.deepEqual(
        sortById(deleted),
        sortById(read),
        'return create() matches return of getByDocId()'
      )
    })

    await t.test('delete forks', async () => {
      const projectId = await manager.createProject()
      const project = await manager.getProject(projectId)
      const written = await create(project, value)
      const updateValue = getUpdateFixture(value)
      const updatedFork1 = await update(project, written.versionId, updateValue)
      const updatedFork2 = await update(project, written.versionId, updateValue)
      const updatedReRead = await project[schemaName].getByDocId(written.docId)
      assert.deepEqual(
        updatedFork2,
        updatedReRead,
        'return of update() matched return of getByDocId()'
      )
      assert.deepEqual(
        updatedReRead.forks,
        [updatedFork1.versionId],
        'doc is forked'
      )
      const deleted = await project[schemaName].delete(written.docId)
      assert(deleted.deleted, 'doc is deleted')
      assert.equal(deleted.forks.length, 0, 'forks are deleted')
      const deletedReRead = await project[schemaName].getByDocId(written.docId)
      assert(deletedReRead.deleted, 'doc is deleted')
      assert.equal(deletedReRead.forks.length, 0, 'forks are deleted')
    })
  }
})

function trackPositionFixture() {
  return {
    timestamp: randomDate().toISOString(),
    mocked: randomBool(),
    coords: {
      latitude: randomNum({ min: -90, max: 90, precision: 6 }),
      longitude: randomNum({ min: -180, max: 180, precision: 6 }),
      altitude: randomNum({ min: 0, max: 5000 }),
      accuracy: randomNum({ min: 0, max: 100, precision: 2 }),
      heading: randomNum({ min: 0, max: 360, precision: 6 }),
      speed: randomNum({ min: 0, max: 100, precision: 2 }),
    },
  }
}
