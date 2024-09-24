import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { pEvent } from 'p-event'
import { setTimeout as delay } from 'timers/promises'
import { request } from 'undici'
import FakeTimers from '@sinonjs/fake-timers'
import Fastify from 'fastify'
import { map } from 'iterpal'
import {
  connectPeers,
  createManager,
  createManagers,
  invite,
  seedDatabases,
  waitForPeers,
  waitForSync,
} from './utils.js'
import { kCoreManager } from '../src/mapeo-project.js'
import { getKeys } from '../tests/helpers/core-manager.js'
import { NAMESPACES, PRESYNC_NAMESPACES } from '../src/constants.js'
import { FastifyController } from '../src/fastify-controller.js'
import { generate } from '@mapeo/mock-data'
import { valueOf } from '../src/utils.js'
import pTimeout from 'p-timeout'
import { BLOCKED_ROLE_ID, COORDINATOR_ROLE_ID } from '../src/roles.js'
import { kSyncState } from '../src/sync/sync-api.js'
import { blobMetadata } from '../tests/helpers/blob-store.js'
/** @import { State } from '../src/sync/sync-api.js' */

const SCHEMAS_INITIAL_SYNC = ['preset', 'field']

test('Create and sync data', { timeout: 100_000 }, async (t) => {
  const COUNT = 10
  const managers = await createManagers(COUNT, t)
  const [invitor, ...invitees] = managers
  const disconnect = connectPeers(managers)
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({ invitor, invitees, projectId })
  await disconnect()

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const generatedDocs = (await seedDatabases(projects)).flat()
  const generatedSchemaNames = generatedDocs.reduce((acc, cur) => {
    acc.add(cur.schemaName)
    return acc
  }, new Set())

  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)
  await waitForSync(projects, 'initial')

  await Promise.all(
    map(generatedSchemaNames, (schemaName) =>
      Promise.all(
        map(projects, async (project) => {
          const deviceId = project.deviceId.slice(0, 7)
          // @ts-ignore - to complex to narrow `schemaName` to valid values
          const docs = await project[schemaName].getMany()
          const expected = generatedDocs.filter(
            (v) => v.schemaName === schemaName
          )
          if (SCHEMAS_INITIAL_SYNC.includes(schemaName)) {
            assert.deepEqual(
              new Set(docs),
              new Set(expected),
              `All ${schemaName} docs synced to ${deviceId}`
            )
          } else {
            assert.notEqual(
              docs.length,
              expected.length,
              `Not all ${schemaName} docs synced to ${deviceId}`
            )
          }
        })
      )
    )
  )

  for (const project of projects) {
    project.$sync.start()
  }

  await waitForSync(projects, 'full')

  await Promise.all(
    map(generatedSchemaNames, (schemaName) =>
      Promise.all(
        map(projects, async (project) => {
          const deviceId = project.deviceId.slice(0, 7)
          // @ts-ignore - too complex to narrow `schemaName` to valid values
          const docs = await project[schemaName].getMany()
          const expected = generatedDocs.filter(
            (v) => v.schemaName === schemaName
          )
          assert.deepEqual(
            new Set(docs),
            new Set(expected),
            `All ${schemaName} docs synced to ${deviceId}`
          )
        })
      )
    )
  )
})

test('syncing blobs', async (t) => {
  const invitor = createManager('invitor', t)

  const fastify = Fastify()
  const fastifyController = new FastifyController({ fastify })
  t.after(() => fastifyController.stop())
  const invitee = createManager('invitee', t, { fastify })

  const managers = [invitee, invitor]

  await Promise.all([
    invitor.setDeviceInfo({ name: 'invitor', deviceType: 'mobile' }),
    invitee.setDeviceInfo({ name: 'invitee', deviceType: 'mobile' }),
    fastifyController.start(),
  ])

  let disconnectPeers = connectPeers(managers)
  t.after(() => disconnectPeers())
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({ invitor, invitees: [invitee], projectId })
  await disconnectPeers()

  const projects = await Promise.all([
    invitor.getProject(projectId),
    invitee.getProject(projectId),
  ])
  const [invitorProject, inviteeProject] = projects

  const fixturePath = new URL(
    '../tests/fixtures/images/02-digidem-logo.jpg',
    import.meta.url
  ).pathname

  const blob = await invitorProject.$blobs.create(
    { original: fixturePath },
    blobMetadata({ mimeType: 'image/jpeg' })
  )

  disconnectPeers = connectPeers(managers)
  await waitForSync(projects, 'initial')

  invitorProject.$sync.start()
  inviteeProject.$sync.start()

  await waitForSync(projects, 'full')

  const blobUrl = await inviteeProject.$blobs.getUrl({
    ...blob,
    variant: 'original',
  })
  const response = await request(blobUrl, { reset: true })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(
    Buffer.from(await response.body.arrayBuffer()),
    await fs.readFile(fixturePath),
    'blob makes it to the other side'
  )
})

test('start and stop sync', async function (t) {
  // Checks that both peers need to start syncing for data to sync, and that
  // $sync.stop() actually stops data syncing
  const COUNT = 2
  const managers = await createManagers(COUNT, t)
  const [invitor, ...invitees] = managers
  const disconnect = connectPeers(managers)
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({ invitor, invitees, projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const [invitorProject, inviteeProject] = projects

  const obs1 = await invitorProject.observation.create(
    valueOf(generate('observation')[0])
  )
  await waitForSync(projects, 'initial')
  inviteeProject.$sync.start()

  await assert.rejects(
    () => pTimeout(waitForSync(projects, 'full'), { milliseconds: 1000 }),
    'wait for sync times out'
  )

  await assert.rejects(
    () => inviteeProject.observation.getByDocId(obs1.docId),
    'before both peers have started sync, doc does not sync'
  )

  invitorProject.$sync.start()

  // Use the same timeout as above, to check that it would have synced given the timeout
  await pTimeout(waitForSync(projects, 'full'), { milliseconds: 1000 })

  const obs1Synced = await inviteeProject.observation.getByDocId(obs1.docId)

  assert.deepEqual(obs1Synced, obs1, 'observation is synced')

  inviteeProject.$sync.stop()

  const obs2 = await inviteeProject.observation.create(
    valueOf(generate('observation')[0])
  )
  await waitForSync(projects, 'initial')

  await assert.rejects(
    () => pTimeout(waitForSync(projects, 'full'), { milliseconds: 1000 }),
    'wait for sync times out'
  )

  await assert.rejects(
    () => invitorProject.observation.getByDocId(obs2.docId),
    'after stopping sync, data does not sync'
  )

  inviteeProject.$sync.start()

  await pTimeout(waitForSync(projects, 'full'), { milliseconds: 1000 })

  const obs2Synced = await invitorProject.observation.getByDocId(obs2.docId)

  assert.deepEqual(obs2Synced, obs2, 'observation is synced')

  await disconnect()
})

test('sync only happens if both sides are enabled', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, ...invitees] = managers

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({ invitor, invitees, projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  t.after(() => Promise.all(projects.map((project) => project.close())))
  const [invitorProject, inviteeProject] = projects

  const generatedObservations = generate('observation', { count: 3 })

  const obs1 = await invitorProject.observation.create(
    valueOf(generatedObservations[0])
  )
  const obs2 = await inviteeProject.observation.create(
    valueOf(generatedObservations[1])
  )

  await waitForSync(projects, 'initial')

  invitorProject.$sync.start()
  inviteeProject.$sync.start()
  await waitForSync(projects, 'full')

  assert(await inviteeProject.observation.getByDocId(obs1.docId))
  assert(await invitorProject.observation.getByDocId(obs2.docId))

  invitorProject.$sync.stop()
  inviteeProject.$sync.stop()

  const obs3 = await invitorProject.observation.create(
    valueOf(generatedObservations[2])
  )

  invitorProject.$sync.start()

  await assert.rejects(
    () => pTimeout(waitForSync(projects, 'full'), { milliseconds: 1000 }),
    'wait for sync times out'
  )

  await assert.rejects(
    () => inviteeProject.observation.getByDocId(obs3.docId),
    'one side stopping sync should prevent data from syncing'
  )
})

test('auto-stop', async (t) => {
  const clock = FakeTimers.install({ shouldAdvanceTime: true })
  t.after(() => clock.uninstall())

  const invitor = createManager('invitor', t)

  const fastify = Fastify()
  const fastifyController = new FastifyController({ fastify })
  t.after(() => fastifyController.stop())
  const invitee = createManager('invitee', t, { fastify })

  const managers = [invitor, invitee]

  await Promise.all([
    invitor.setDeviceInfo({ name: 'invitor', deviceType: 'mobile' }),
    invitee.setDeviceInfo({ name: 'invitee', deviceType: 'mobile' }),
    fastifyController.start(),
  ])
  t.after(() => fastifyController.stop())

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectId = await invitor.createProject({ name: 'mapeo' })
  await invite({ invitor, invitees: [invitee], projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const [invitorProject, inviteeProject] = projects

  const generatedObservations = generate('observation', { count: 2 })

  invitorProject.$sync.start({ autostopDataSyncAfter: 10_000 })
  inviteeProject.$sync.start({ autostopDataSyncAfter: 10_000 })

  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    "invitor hasn't auto-stopped yet"
  )
  assert(
    inviteeProject.$sync.getState().data.isSyncEnabled,
    "invitee hasn't auto-stopped yet"
  )

  const observation1 = await invitorProject.observation.create(
    valueOf(generatedObservations[0])
  )
  await waitForSync(projects, 'full')
  assert(
    await inviteeProject.observation.getByDocId(observation1.docId),
    'invitee receives doc'
  )

  await clock.tickAsync(9000)

  const fixturePath = new URL(
    '../tests/fixtures/images/02-digidem-logo.jpg',
    import.meta.url
  ).pathname
  const blob = await invitorProject.$blobs.create(
    { original: fixturePath },
    blobMetadata({ mimeType: 'image/jpeg' })
  )
  await waitForSync(projects, 'full')
  const blobUrl = await inviteeProject.$blobs.getUrl({
    ...blob,
    variant: 'original',
  })
  const response = await request(blobUrl, { reset: true })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(
    Buffer.from(await response.body.arrayBuffer()),
    await fs.readFile(fixturePath),
    'invitee receives blob'
  )

  await clock.tickAsync(9000)

  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    "invitor hasn't auto-stopped yet because the timer has been restarted"
  )
  assert(
    inviteeProject.$sync.getState().data.isSyncEnabled,
    "invitee hasn't auto-stopped yet because the timer has been restarted"
  )

  let invitorProjectOnSyncDisabled = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ data: { isSyncEnabled } }) => !isSyncEnabled
  )
  const inviteeProjectOnSyncDisabled = pEvent(
    inviteeProject.$sync,
    'sync-state',
    ({ data: { isSyncEnabled } }) => !isSyncEnabled
  )

  clock.tick(2000)

  await Promise.all([
    invitorProjectOnSyncDisabled,
    inviteeProjectOnSyncDisabled,
  ])
  assert(
    !invitorProject.$sync.getState().data.isSyncEnabled,
    'invitor has auto-stopped'
  )
  assert(
    !inviteeProject.$sync.getState().data.isSyncEnabled,
    'invitee has auto-stopped'
  )

  invitorProject.$sync.setAutostopDataSyncTimeout(20_000)
  assert(
    !invitorProject.$sync.getState().data.isSyncEnabled,
    'invitor is still stopped'
  )

  invitorProject.$sync.start()
  inviteeProject.$sync.start()

  const observation2 = await invitorProject.observation.create(
    valueOf(generatedObservations[1])
  )
  await waitForSync(projects, 'full')
  assert(
    await inviteeProject.observation.getByDocId(observation2.docId),
    'invitee receives doc'
  )

  await clock.tickAsync(19_000)

  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    "invitor hasn't auto-stopped"
  )

  invitorProjectOnSyncDisabled = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ data: { isSyncEnabled } }) => !isSyncEnabled
  )

  clock.tick(2_000)

  await invitorProjectOnSyncDisabled
  assert(
    !invitorProject.$sync.getState().data.isSyncEnabled,
    'invitor has auto-stopped'
  )

  invitorProject.$sync.start({ autostopDataSyncAfter: 999_999 })
  invitorProject.$sync.setAutostopDataSyncTimeout(20_000)

  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    'invitor has not yet auto-stopped'
  )

  invitorProjectOnSyncDisabled = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ data: { isSyncEnabled } }) => !isSyncEnabled
  )
  clock.tick(21_000)
  await invitorProjectOnSyncDisabled

  assert(
    !invitorProject.$sync.getState().data.isSyncEnabled,
    'invitor has auto-stopped'
  )
})

test('disabling auto-stop timeout', async (t) => {
  const clock = FakeTimers.install({ shouldAdvanceTime: true })
  t.after(() => clock.uninstall())

  const managers = await createManagers(2, t)
  const [invitor, ...invitees] = managers

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectId = await invitor.createProject({ name: 'mapeo' })
  await invite({ invitor, invitees, projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const [invitorProject, inviteeProject] = projects

  invitorProject.$sync.start({ autostopDataSyncAfter: 10_000 })
  invitorProject.$sync.setAutostopDataSyncTimeout(null)

  inviteeProject.$sync.start()

  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    "invitor hasn't auto-stopped yet"
  )

  const observation1 = await invitorProject.observation.create(
    valueOf(generate('observation')[0])
  )
  await waitForSync(projects, 'full')
  assert(
    await inviteeProject.observation.getByDocId(observation1.docId),
    'invitee receives doc'
  )

  await clock.tickAsync(999_999_999)
  assert(
    invitorProject.$sync.getState().data.isSyncEnabled,
    "invitor still hasn't auto-stopped"
  )
})

test('validates auto-stop timeouts', async (t) => {
  const manager = await createManager('test', t)
  const projectId = await manager.createProject({ name: 'foo' })
  const project = await manager.getProject(projectId)

  const invalid = [-Infinity, 0, 1.23, 2 ** 31, Infinity]
  for (const autostopDataSyncAfter of invalid) {
    assert.throws(() => {
      project.$sync.start({ autostopDataSyncAfter })
    })
    assert.throws(() => {
      project.$sync.setAutostopDataSyncTimeout(autostopDataSyncAfter)
    })
  }

  assert(!project.$sync.getState().data.isSyncEnabled, 'sync is not enabled')
})

test('gracefully shutting down sync for all projects when backgrounded', async function (t) {
  const managers = await createManagers(2, t)
  const [invitor, ...invitees] = managers

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectGroupsAfterFirstStep = await Promise.all(
    [1, 2, 3].map(async (projectNumber) => {
      const projectId = await invitor.createProject({
        name: `Project ${projectNumber}`,
      })

      await invite({ invitor, invitees, projectId })

      const projects = await Promise.all(
        managers.map((m) => m.getProject(projectId))
      )
      const [invitorProject, inviteeProject] = projects

      const observation1 = await invitorProject.observation.create(
        valueOf(generate('observation')[0])
      )

      await assert.rejects(
        () => inviteeProject.observation.getByDocId(observation1.docId),
        'before peers have started sync, doc does not sync'
      )

      inviteeProject.$sync.start()
      invitorProject.$sync.start()

      await waitForSync(projects, 'full')

      return { invitorProject, inviteeProject, observation1 }
    })
  )

  invitor.onBackgrounded()

  const projectGroupsAfterSecondStep = await Promise.all(
    projectGroupsAfterFirstStep.map(
      async ({ invitorProject, inviteeProject, observation1 }) => {
        assert(
          await inviteeProject.observation.getByDocId(observation1.docId),
          'invitee receives doc'
        )

        const observation2 = await invitorProject.observation.create(
          valueOf(generate('observation')[0])
        )
        const observation3 = await inviteeProject.observation.create(
          valueOf(generate('observation')[0])
        )
        await delay(1000)
        await assert.rejects(
          () => inviteeProject.observation.getByDocId(observation2.docId),
          "invitee doesn't receive second doc yet"
        )
        await assert.rejects(
          () => invitorProject.observation.getByDocId(observation3.docId),
          "invitor doesn't receive third doc yet"
        )

        return { invitorProject, inviteeProject, observation2, observation3 }
      }
    )
  )

  invitor.onForegrounded()

  await Promise.all(
    projectGroupsAfterSecondStep.map(
      async ({
        invitorProject,
        inviteeProject,
        observation2,
        observation3,
      }) => {
        await waitForSync([invitorProject, inviteeProject], 'full')

        assert(
          await inviteeProject.observation.getByDocId(observation2.docId),
          'invitee receives second doc'
        )
        assert(
          await invitorProject.observation.getByDocId(observation3.docId),
          'invitor receives third doc'
        )
      }
    )
  )
})

test('shares cores', async function (t) {
  const COUNT = 5
  const managers = await createManagers(COUNT, t)
  const [invitor, ...invitees] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({ invitor, invitees, projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const coreManagers = projects.map((p) => p[kCoreManager])

  await waitForSync(projects, 'initial')

  for (const ns of PRESYNC_NAMESPACES) {
    for (const cm of coreManagers) {
      const keyCount = getKeys(cm, ns).length
      assert.equal(keyCount, COUNT, 'expected number of cores')
    }
  }

  // Currently need to start syncing to share other keys - this might change if
  // we add keys based on coreOwnership records
  for (const project of projects) {
    project.$sync.start()
  }
  const everyoneEnabledDataSyncPromise = await Promise.all(
    projects.map((project) =>
      pEvent(project.$sync, 'sync-state', (state) => state.data.isSyncEnabled)
    )
  )

  await waitForSync(projects, 'full')
  await everyoneEnabledDataSyncPromise

  for (const ns of NAMESPACES) {
    for (const cm of coreManagers) {
      const keyCount = getKeys(cm, ns).length
      assert.equal(keyCount, COUNT, 'expected number of cores')
    }
  }
})

test('no sync capabilities === no namespaces sync apart from auth', async (t) => {
  const COUNT = 3
  const managers = await createManagers(COUNT, t)
  const [invitor, invitee, blocked] = managers
  const disconnect1 = connectPeers(managers)
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await invite({
    invitor,
    invitees: [blocked],
    projectId,
    roleId: BLOCKED_ROLE_ID,
  })
  await invite({
    invitor,
    invitees: [invitee],
    projectId,
    roleId: COORDINATOR_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const [invitorProject, inviteeProject] = projects

  const generatedDocs = (await seedDatabases([inviteeProject])).flat()
  const configDocsCount = generatedDocs.filter(
    (doc) => doc.schemaName !== 'observation'
  ).length
  const dataDocsCount = generatedDocs.length - configDocsCount

  for (const project of projects) {
    project.$sync.start()
  }

  await waitForSync([inviteeProject, invitorProject], 'full')

  // Reaching into internals here, but only to validate the result of the test, so not fully e2e
  const [invitorState, inviteeState, blockedState] = projects.map((p) =>
    p.$sync[kSyncState].getState()
  )

  assert.equal(invitorState.config.localState.have, configDocsCount + COUNT) // count device info doc for each invited device
  assert.equal(invitorState.data.localState.have, dataDocsCount)
  assert.equal(blockedState.config.localState.have, 1) // just the device info doc
  assert.equal(blockedState.data.localState.have, 0) // no data docs synced

  for (const ns of NAMESPACES) {
    assert.equal(invitorState[ns].coreCount, 3, ns)
    assert.equal(inviteeState[ns].coreCount, 3, ns)
    assert.equal(blockedState[ns].coreCount, 3, ns)
    assert.deepEqual(
      invitorState[ns].localState,
      inviteeState[ns].localState,
      ns
    )
  }

  await disconnect1()

  await Promise.all(projects.map((p) => p.close()))
})

test('Sync state emitted when starting and stopping sync', async function (t) {
  const COUNT = 2
  const managers = await createManagers(COUNT, t)
  const [invitor, ...invitees] = managers
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const project = await invitor.getProject(projectId)
  t.after(() => project.close())

  /** @type {State[]} */ const statesBeforeStart = []

  /** @type {State[]} */ let states = statesBeforeStart
  project.$sync.on('sync-state', (state) => states.push(state))

  const disconnect = connectPeers(managers)
  t.after(disconnect)
  await waitForPeers(managers)
  await invite({ invitor, invitees, projectId })

  /** @type {State[]} */ const statesAfterStart = []
  states = statesAfterStart
  project.$sync.start()
  assert(
    statesAfterStart.length >= 1,
    'Expected at least one event after starting'
  )
  for (const state of statesAfterStart) {
    assert(state.initial.isSyncEnabled, 'initial namespaces are enabled')
    assert(state.data.isSyncEnabled, 'data namespaces are enabled')
  }

  await delay(500)

  /** @type {State[]} */ const statesAfterStop = []
  states = statesAfterStop
  project.$sync.stop()

  for (const state of statesAfterStart) {
    assert(state.initial.isSyncEnabled, 'initial namespaces are enabled')
    assert(state.data.isSyncEnabled, 'data namespaces are enabled')
  }

  assert(
    statesAfterStop.length >= 1,
    'Expected at least one event after stopping'
  )
  for (const state of statesAfterStop) {
    assert(state.initial.isSyncEnabled, 'initial namespaces are still enabled')
    assert(!state.data.isSyncEnabled, 'data namespaces are disabled')
  }
})

test('updates sync state when peers are added', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, ...invitees] = managers
  const [invitee] = invitees

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const invitorProject = await invitor.getProject(projectId)
  t.after(() => invitorProject.close())

  await invitorProject.observation.create(valueOf(generate('observation')[0]))
  assert.deepEqual(
    invitorProject.$sync.getState(),
    {
      initial: { isSyncEnabled: true },
      data: { isSyncEnabled: false },
      remoteDeviceSyncState: {},
    },
    'data sync state is correct at start'
  )

  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)
  await waitForPeers(managers)
  await invite({ invitor, invitees, projectId })

  assert.deepEqual(
    invitorProject.$sync.getState(),
    {
      initial: { isSyncEnabled: true },
      data: { isSyncEnabled: false },
      remoteDeviceSyncState: {
        [invitee.deviceId]: {
          initial: { isSyncEnabled: true, want: 0, wanted: 0 },
          data: { isSyncEnabled: false, want: 1, wanted: 0 },
        },
      },
    },
    'there should be something to sync'
  )
})

test('Correct sync state prior to data sync', async function (t) {
  const COUNT = 6
  const managers = await createManagers(COUNT, t)
  const [invitor, ...invitees] = managers
  const projectId = await invitor.createProject({ name: 'Mapeo' })

  const disconnect1 = connectPeers(managers)

  await waitForPeers(managers)
  await invite({ invitor, invitees, projectId })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const generated = await seedDatabases(projects, { schemas: ['observation'] })
  await waitForSync(projects, 'initial')

  // Disconnect and reconnect, because currently pre-have messages about data
  // sync state are only shared on first connection
  await disconnect1()
  const disconnect2 = connectPeers(managers)
  await waitForPeers(managers)

  const expected = managers.map((manager, index) => {
    /** @type {State['remoteDeviceSyncState']} */ const remoteDeviceSyncState =
      {}

    const myDocs = generated[index]

    for (const [otherIndex, otherManager] of managers.entries()) {
      if (manager === otherManager) continue

      const otherDocs = generated[otherIndex]
      const wanted = otherDocs.length
      const want = myDocs.length

      remoteDeviceSyncState[otherManager.deviceId] = {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want, wanted },
      }
    }

    return {
      initial: { isSyncEnabled: true },
      data: { isSyncEnabled: false },
      remoteDeviceSyncState,
    }
  })

  await Promise.all(
    projects.map((project, i) =>
      pEvent(project.$sync, 'sync-state', (syncState) =>
        isDeepStrictEqual(syncState, expected[i])
      )
    )
  )

  const syncState = projects.map((p) => p.$sync.getState())
  assert.deepEqual(syncState, expected)

  await disconnect2()
  await Promise.all(projects.map((p) => p.close()))
})

test('pre-haves are updated', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, ...invitees] = managers
  const [invitee] = invitees

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  await waitForPeers(managers)
  await invite({ invitor, invitees, projectId })
  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  for (const project of projects) t.after(() => project.close())
  const [invitorProject, inviteeProject] = projects
  await waitForSync(projects, 'initial')

  assert.deepEqual(
    invitorProject.$sync.getState().remoteDeviceSyncState[invitee.deviceId]
      .data,
    {
      isSyncEnabled: false,
      want: 0,
      wanted: 0,
    },
    'Invitor project should have nothing to sync at start'
  )
  assert.deepEqual(
    inviteeProject.$sync.getState().remoteDeviceSyncState[invitor.deviceId]
      .data,
    {
      isSyncEnabled: false,
      want: 0,
      wanted: 0,
    },
    'Invitee project should have nothing to sync at start'
  )

  const invitorToSyncPromise = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) =>
      remoteDeviceSyncState[invitee.deviceId]?.data.want > 0
  )
  const inviteeToSyncPromise = pEvent(
    inviteeProject.$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) =>
      remoteDeviceSyncState[invitor.deviceId]?.data.wanted > 0
  )

  await invitorProject.observation.create(valueOf(generate('observation')[0]))

  await Promise.all([invitorToSyncPromise, inviteeToSyncPromise])

  assert.deepEqual(
    inviteeProject.$sync.getState().remoteDeviceSyncState[invitor.deviceId]
      .data,
    {
      isSyncEnabled: false,
      want: 0,
      wanted: 1,
    },
    'Invitee project should learn about something to sync'
  )
})

test('data sync state is properly updated as data sync is enabled and disabled', async (t) => {
  const managers = await createManagers(3, t)
  const [invitor, ...invitees] = managers

  const disconnect = connectPeers(managers)
  t.after(disconnect)

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const invitorProject = await invitor.getProject(projectId)
  invitorProject.observation.create(valueOf(generate('observation')[0]))
  assert.ok(
    invitorProject.$sync.getState().initial.isSyncEnabled,
    'initial sync is enabled for local device'
  )

  await waitForPeers(managers)
  await invite({ invitor, invitees, projectId })
  const inviteesProjects = await Promise.all(
    invitees.map((m) => m.getProject(projectId))
  )
  await waitForSync([invitorProject, ...inviteesProjects], 'initial')

  assert.deepEqual(
    invitorProject.$sync.getState().remoteDeviceSyncState,
    {
      [invitees[0].deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 1, wanted: 0 },
      },
      [invitees[1].deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 1, wanted: 0 },
      },
    },
    "from the invitor's perspective, remote peers want one document and data sync is disabled"
  )
  assert.deepEqual(
    inviteesProjects[0].$sync.getState().remoteDeviceSyncState,
    {
      [invitorProject.deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 0, wanted: 1 },
      },
      [invitees[1].deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 0, wanted: 0 },
      },
    },
    "from one invitee's perspective, one remote peer has a document and data sync is disabled"
  )

  invitorProject.$sync.start()

  assert.ok(
    invitorProject.$sync.getState().data.isSyncEnabled,
    'after enabled sync, data sync is enabled for local device'
  )
  assert.deepEqual(
    invitorProject.$sync.getState().remoteDeviceSyncState,
    {
      [invitees[0].deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 1, wanted: 0 },
      },
      [invitees[1].deviceId]: {
        initial: { isSyncEnabled: true, want: 0, wanted: 0 },
        data: { isSyncEnabled: false, want: 1, wanted: 0 },
      },
    },
    'data sync is still disabled for remote peers'
  )

  const inviteeAppearsEnabledPromise = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) =>
      remoteDeviceSyncState[invitees[0].deviceId]?.data.isSyncEnabled
  )
  const invitorProjectSyncedWithFirstInviteePromise = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) => {
      const remoteData = remoteDeviceSyncState[invitees[0].deviceId]?.data ?? {}
      return remoteData.want + remoteData.wanted === 0
    }
  )
  const firstInviteeProjectSyncedWithInvitorPromise = pEvent(
    inviteesProjects[0].$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) => {
      const remoteData = remoteDeviceSyncState[invitor.deviceId]?.data ?? {}
      return remoteData.want + remoteData.wanted === 0
    }
  )

  inviteesProjects[0].$sync.start()

  assert.ok(
    inviteesProjects[0].$sync.getState().data.isSyncEnabled,
    'invitee has data sync enabled after starting sync'
  )

  await inviteeAppearsEnabledPromise

  assert(
    invitorProject.$sync.getState().remoteDeviceSyncState[invitees[0].deviceId]
      ?.data.isSyncEnabled,
    'one invitee has enabled data sync'
  )
  assert(
    !invitorProject.$sync.getState().remoteDeviceSyncState[invitees[1].deviceId]
      ?.data.isSyncEnabled,
    'other invitee has not enabled data sync'
  )

  await Promise.all([
    invitorProjectSyncedWithFirstInviteePromise,
    firstInviteeProjectSyncedWithInvitorPromise,
  ])

  const inviteeAppearsDisabledPromise = pEvent(
    invitorProject.$sync,
    'sync-state',
    ({ remoteDeviceSyncState }) =>
      !remoteDeviceSyncState[invitees[0].deviceId]?.data.isSyncEnabled
  )

  inviteesProjects[0].$sync.stop()

  await inviteeAppearsDisabledPromise

  const finalRemoteDeviceSyncState =
    invitorProject.$sync.getState().remoteDeviceSyncState
  assert.deepEqual(
    finalRemoteDeviceSyncState[invitees[0].deviceId],
    {
      initial: { isSyncEnabled: true, want: 0, wanted: 0 },
      data: { isSyncEnabled: false, want: 0, wanted: 0 },
    },
    'one invitee is disabled but settled'
  )
  assert.deepEqual(
    finalRemoteDeviceSyncState[invitees[1].deviceId],
    {
      initial: { isSyncEnabled: true, want: 0, wanted: 0 },
      data: { isSyncEnabled: false, want: 1, wanted: 0 },
    },
    'other invitee is still disabled, still wants something'
  )
})
