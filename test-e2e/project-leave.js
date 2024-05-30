import { test } from 'brittle'
import assert from 'node:assert/strict'

import {
  BLOCKED_ROLE_ID,
  COORDINATOR_ROLE_ID,
  ROLES,
  LEFT_ROLE_ID,
  MEMBER_ROLE_ID,
} from '../src/roles.js'
import { MapeoProject } from '../src/mapeo-project.js'
import {
  ManagerCustodian,
  connectPeers,
  createManagers,
  disconnectPeers,
  invite,
  waitForPeers,
  waitForSync,
} from './utils.js'

test('Creator cannot leave project if they are the only member', async (t) => {
  const [creatorManager] = await createManagers(1, t)

  const projectId = await creatorManager.createProject({ name: 'mapeo' })

  await t.exception(async () => {
    await creatorManager.leaveProject(projectId)
  }, 'attempting to leave fails')
})

test('Creator cannot leave project if no other coordinators exist', async (t) => {
  const managers = await createManagers(2, t)

  connectPeers(managers)
  await waitForPeers(managers)

  const [creator, member] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await invite({
    invitor: creator,
    invitees: [member],
    projectId,
    roleId: MEMBER_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [creatorProject, memberProject] = projects

  t.ok(
    await creatorProject.$member.getById(member.deviceId),
    'member successfully added from creator perspective'
  )

  t.ok(
    await memberProject.$member.getById(creator.deviceId),
    'creator successfully added from member perspective'
  )

  await t.exception(async () => {
    await creator.leaveProject(projectId)
  }, 'creator attempting to leave project with no other coordinators fails')

  await disconnectPeers(managers)
})

test('Blocked member cannot leave project', async (t) => {
  const managers = await createManagers(2, t)

  connectPeers(managers)
  await waitForPeers(managers)

  const [creator, member] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await invite({
    invitor: creator,
    invitees: [member],
    projectId,
    roleId: MEMBER_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [creatorProject, memberProject] = projects

  t.alike(
    await memberProject.$getOwnRole(),
    ROLES[MEMBER_ROLE_ID],
    'Member is initially a member'
  )

  await creatorProject.$member.assignRole(member.deviceId, BLOCKED_ROLE_ID)

  await waitForSync(projects, 'initial')

  t.alike(
    await memberProject.$getOwnRole(),
    ROLES[BLOCKED_ROLE_ID],
    'Member is now blocked'
  )

  await t.exception(async () => {
    await member.leaveProject(projectId)
  }, 'Member attempting to leave project fails')

  await disconnectPeers(managers)
})

test('Creator can leave project if another coordinator exists', async (t) => {
  const managers = await createManagers(2, t)

  connectPeers(managers)
  await waitForPeers(managers)

  const [creator, coordinator] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await invite({
    invitor: creator,
    invitees: [coordinator],
    projectId,
    roleId: COORDINATOR_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [creatorProject, coordinatorProject] = projects

  t.ok(
    await creatorProject.$member.getById(coordinator.deviceId),
    'coordinator successfully added from creator perspective'
  )

  t.ok(
    await coordinatorProject.$member.getById(coordinator.deviceId),
    'creator successfully added from creator perspective'
  )

  await waitForSync(projects, 'initial')

  await creator.leaveProject(projectId)

  t.alike(
    await creatorProject.$getOwnRole(),
    ROLES[LEFT_ROLE_ID],
    'creator now has LEFT role'
  )

  await waitForSync(projects, 'initial')

  t.is(
    (await coordinatorProject.$member.getById(creator.deviceId)).role,
    ROLES[LEFT_ROLE_ID],
    'coordinator can still retrieve info about creator who left'
  )

  await disconnectPeers(managers)
})

test('Member can leave project if creator exists', async (t) => {
  const managers = await createManagers(2, t)

  connectPeers(managers)
  await waitForPeers(managers)

  const [creator, member] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await invite({
    invitor: creator,
    invitees: [member],
    projectId,
    roleId: MEMBER_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [creatorProject, memberProject] = projects

  t.ok(
    await creatorProject.$member.getById(member.deviceId),
    'member successfully added from creator perspective'
  )

  t.ok(
    await memberProject.$member.getById(creator.deviceId),
    'creator successfully added from member perspective'
  )

  await waitForSync(projects, 'initial')

  await member.leaveProject(projectId)

  t.alike(
    await memberProject.$getOwnRole(),
    ROLES[LEFT_ROLE_ID],
    'member now has LEFT role'
  )

  await waitForSync(projects, 'initial')

  t.is(
    (await creatorProject.$member.getById(member.deviceId)).role,
    ROLES[LEFT_ROLE_ID],
    'creator can still retrieve info about member who left'
  )

  await disconnectPeers(managers)
})

test('Data access after leaving project', async (t) => {
  const managers = await createManagers(3, t)

  connectPeers(managers)
  await waitForPeers(managers)

  const [creator, coordinator, member] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await Promise.all([
    invite({
      invitor: creator,
      invitees: [coordinator],
      projectId,
      roleId: COORDINATOR_ROLE_ID,
    }),
    invite({
      invitor: creator,
      invitees: [member],
      projectId,
      roleId: MEMBER_ROLE_ID,
    }),
  ])

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [, coordinatorProject, memberProject] = projects

  await memberProject.observation.create({
    schemaName: 'observation',
    attachments: [],
    tags: {},
    refs: [],
    metadata: {},
  })
  t.ok(
    (await memberProject.observation.getMany()).length >= 1,
    'Test is set up correctly'
  )

  await waitForSync(projects, 'initial')

  await Promise.all([
    coordinator.leaveProject(projectId),
    member.leaveProject(projectId),
  ])

  await waitForSync(projects, 'initial')

  await t.exception(async () => {
    await memberProject.observation.create({
      schemaName: 'observation',
      attachments: [],
      tags: {},
      refs: [],
      metadata: {},
    })
  }, 'member cannot create new data after leaving')
  await t.exception(
    () => memberProject.observation.getMany(),
    "Shouldn't be able to fetch observations after leaving"
  )

  t.alike(
    await memberProject.$getProjectSettings(),
    MapeoProject.EMPTY_PROJECT_SETTINGS,
    'member getting project settings returns empty settings'
  )

  t.alike(
    await coordinatorProject.$getProjectSettings(),
    MapeoProject.EMPTY_PROJECT_SETTINGS,
    'coordinator getting project settings returns empty settings'
  )

  await t.exception(async () => {
    await coordinatorProject.$setProjectSettings({ name: 'foo' })
  }, 'coordinator cannot update project settings after leaving')

  await disconnectPeers(managers)
})

test('leaving a project while disconnected', async (t) => {
  const managers = await createManagers(2, t)

  let disconnectPeers = connectPeers(managers)
  t.teardown(() => disconnectPeers())

  await waitForPeers(managers)

  const [creator, member] = managers
  const projectId = await creator.createProject({ name: 'mapeo' })

  await invite({
    invitor: creator,
    invitees: [member],
    projectId,
    roleId: MEMBER_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )
  const [creatorProject] = projects

  await disconnectPeers()

  await member.leaveProject(projectId)

  t.ok(
    await creatorProject.$member.getById(member.deviceId),
    'creator still thinks member is part of project'
  )

  disconnectPeers = connectPeers(managers)
  await waitForPeers(managers)

  await waitForSync(projects, 'initial')

  t.is(
    (await creatorProject.$member.getById(member.deviceId)).role.roleId,
    LEFT_ROLE_ID,
    'creator no longer thinks member is part of project'
  )
})

test('partly-left projects are cleaned up on startup', async (t) => {
  // NOTE: Unlike other tests in this file, this test uses `node:assert` instead
  // of `t` to ease our transition away from Brittle. We can remove this comment
  // when Brittle is removed.
  const custodian = new ManagerCustodian(t)

  const projectId = await custodian.withManagerInSeparateProcess(
    async (manager, LEFT_ROLE_ID) => {
      const projectId = await manager.createProject({ name: 'foo' })
      const project = await manager.getProject(projectId)
      await project.observation.create({
        schemaName: 'observation',
        attachments: [],
        tags: {},
        refs: [],
        metadata: {},
      })
      await project.$member.assignRole(
        manager.getDeviceInfo().deviceId,
        /**
         * This test-only hack assigns the "left" role ID without actually
         * cleaning up the project.
         * @type {any}
         */ (LEFT_ROLE_ID)
      )
      return projectId
    },
    LEFT_ROLE_ID
  )

  const couldGetObservations = await custodian.withManagerInSeparateProcess(
    async (manager, projectId) => {
      const project = await manager.getProject(projectId)
      return project.observation
        .getMany()
        .then(() => true)
        .catch(() => false)
    },
    projectId
  )

  assert(
    !couldGetObservations,
    "Shouldn't be able to fetch observations after leaving"
  )
})

// TODO: Add test for leaving and rejoining a project
