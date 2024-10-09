import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'crypto'
import { once } from 'node:events'

import {
  COORDINATOR_ROLE_ID,
  CREATOR_ROLE,
  ROLES,
  MEMBER_ROLE_ID,
  NO_ROLE,
} from '../src/roles.js'
import {
  connectPeers,
  createManagers,
  invite,
  removeUndefinedFields,
  waitForSync,
} from './utils.js'
import { kDataTypes } from '../src/mapeo-project.js'

test('getting yourself after creating project', async (t) => {
  const [manager] = await createManagers(1, t, 'tablet')

  const deviceInfo = manager.getDeviceInfo()
  const project = await manager.getProject(await manager.createProject())

  const { joinedAt, ...me } = await project.$member.getById(project.deviceId)
  assert.ok(joinedAt, 'has a `joinedAt` field')

  const joinedAtUnix = new Date(joinedAt).getTime()
  const now = new Date().getTime()

  assert.ok(
    Math.abs(joinedAtUnix - now) < 1000,
    'time of joined project is close to now'
  )
  assert.deepEqual(
    removeUndefinedFields(me),
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: CREATOR_ROLE,
    },
    'has expected member info with creator role'
  )

  const members = await project.$member.getMany()
  const { joinedAt: _, ...member } = members[0]

  assert.equal(members.length, 1)
  assert.deepEqual(
    removeUndefinedFields(member),
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: CREATOR_ROLE,
    },
    'has expected member info with creator role'
  )
})

test('getting yourself after adding project (but not yet synced)', async (t) => {
  const [manager] = await createManagers(1, t, 'tablet')

  const deviceInfo = manager.getDeviceInfo()
  const project = await manager.getProject(
    await manager.addProject(
      {
        projectName: 'Mapeo Project',
        projectKey: randomBytes(32),
        encryptionKeys: { auth: randomBytes(32) },
      },
      { waitForSync: false }
    )
  )

  const { joinedAt, ...me } = await project.$member.getById(project.deviceId)
  assert.ok(joinedAt, 'joinedAt exists at project')
  const joinedAtUnix = new Date(joinedAt).getTime()
  const now = new Date().getTime()
  assert.ok(
    Math.abs(now - joinedAtUnix) < 1000,
    'time between joined project and now is short'
  )

  assert.deepEqual(
    removeUndefinedFields(me),
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: NO_ROLE,
    },
    'has expected member info with no role'
  )

  const members = await project.$member.getMany()
  const { joinedAt: _, ...member } = members[0]

  assert.equal(members.length, 1)
  assert.deepEqual(
    removeUndefinedFields(member),
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: NO_ROLE,
    },
    'has expected member info with no role'
  )
})

test('getting invited member after invite rejected', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const project = await invitor.getProject(projectId)

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    reject: true,
  })

  await assert.rejects(
    () => project.$member.getById(invitee.deviceId),
    'invited member cannot be retrieved'
  )

  const members = await project.$member.getMany()

  assert.equal(members.length, 1)
  assert(
    !members.find((m) => m.deviceId === invitee.deviceId),
    'invited member not found'
  )
})

test('getting invited member after invite accepted', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)

  const { name: inviteeName } = invitee.getDeviceInfo()
  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const project = await invitor.getProject(projectId)

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    roleId: MEMBER_ROLE_ID,
  })

  const members = await project.$member.getMany()

  assert.equal(members.length, 2)

  const invitedMember = members.find((m) => m.deviceId === invitee.deviceId)
  if (invitedMember) {
    const { joinedAt, ...invitedMemberWithoutJoinedAt } = invitedMember
    assert.ok(joinedAt, 'joinedAt exists for project')
    const joinedAtUnix = new Date(joinedAt).getTime()
    const now = new Date().getTime()
    assert.ok(
      Math.abs(now - joinedAtUnix) < 1000,
      'time between joined project and now is short'
    )

    assert.deepEqual(
      removeUndefinedFields(invitedMemberWithoutJoinedAt),
      {
        deviceId: invitee.deviceId,
        deviceType: 'device_type_unspecified',
        name: inviteeName,
        role: ROLES[MEMBER_ROLE_ID],
      },
      'has expected member info with member role'
    )
  }

  // TODO: Test that device info of invited member can be read from invitor after syncing
})

test('invite uses custom role name when provided', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  const inviteReceivedPromise = once(invitee.invite, 'invite-received')

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    roleName: 'friend',
    reject: true,
  })

  const [{ roleName }] = await inviteReceivedPromise
  assert.equal(roleName, 'friend', 'roleName should be equal')
})

test('invite uses default role name when not provided', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  const inviteReceivedPromise = once(invitee.invite, 'invite-received')

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    reject: true,
  })

  const [{ roleName }] = await inviteReceivedPromise
  assert.equal(
    roleName,
    ROLES[MEMBER_ROLE_ID].name,
    '`roleName` should use the fallback by deriving `roleId`'
  )
})

test('roles - creator role and role assignment', async (t) => {
  const [manager] = await createManagers(1, t)

  const projectId = await manager.createProject()
  const project = await manager.getProject(projectId)
  const ownRole = await project.$getOwnRole()

  assert.deepEqual(ownRole, CREATOR_ROLE, 'Project creator has creator role')

  const deviceId = randomBytes(32).toString('hex')
  await project.$member.assignRole(deviceId, MEMBER_ROLE_ID)

  const member = await project.$member.getById(deviceId)

  assert.deepEqual(
    member.role,
    ROLES[MEMBER_ROLE_ID],
    'Can assign role to device'
  )
})

test('roles - new device without role', async (t) => {
  const [manager] = await createManagers(1, t)

  const projectId = await manager.addProject(
    {
      projectName: 'Mapeo Project',
      projectKey: randomBytes(32),
      encryptionKeys: { auth: randomBytes(32) },
    },
    { waitForSync: false }
  )

  const project = await manager.getProject(projectId)

  const ownRole = await project.$getOwnRole()

  assert.deepEqual(
    ownRole.sync,
    {
      auth: 'allowed',
      config: 'allowed',
      data: 'blocked',
      blobIndex: 'blocked',
      blob: 'blocked',
    },
    'A new device before sync can sync auth and config namespaces, but not other namespaces'
  )
  await assert.rejects(async () => {
    const deviceId = randomBytes(32).toString('hex')
    await project.$member.assignRole(deviceId, MEMBER_ROLE_ID)
  }, 'Trying to assign a role without the permission throws an error')
})

test('roles - getMany() on invitor device', async (t) => {
  const [manager] = await createManagers(1, t)

  const creatorDeviceId = manager.deviceId

  const projectId = await manager.createProject()
  const project = await manager.getProject(projectId)
  const ownRole = await project.$getOwnRole()

  assert.deepEqual(ownRole, CREATOR_ROLE, 'Project creator has creator role')

  const deviceId1 = randomBytes(32).toString('hex')
  const deviceId2 = randomBytes(32).toString('hex')
  await project.$member.assignRole(deviceId1, MEMBER_ROLE_ID)
  await project.$member.assignRole(deviceId2, COORDINATOR_ROLE_ID)

  const expected = {
    [deviceId1]: ROLES[MEMBER_ROLE_ID],
    [deviceId2]: ROLES[COORDINATOR_ROLE_ID],
    [creatorDeviceId]: CREATOR_ROLE,
  }

  const allMembers = await project.$member.getMany()

  /** @type {Record<string, import('../src/roles.js').Role>} */
  const actual = {}

  for (const member of allMembers) {
    actual[member.deviceId] = member.role
  }

  assert.deepEqual(actual, expected, 'expected roles')
})

test('roles - getMany() on newly invited device before sync', async (t) => {
  const [manager] = await createManagers(1, t)

  const deviceId = manager.deviceId

  const projectId = await manager.addProject(
    {
      projectName: 'Mapeo Project',
      projectKey: randomBytes(32),
      encryptionKeys: { auth: randomBytes(32) },
    },
    { waitForSync: false }
  )
  const project = await manager.getProject(projectId)

  const expected = { [deviceId]: NO_ROLE }

  const allMembers = await project.$member.getMany()

  /** @type {Record<string, import('../src/roles.js').Role>} */
  const actual = {}

  for (const member of allMembers) {
    actual[member.deviceId] = member.role
  }

  assert.deepEqual(actual, expected, 'expected role')
})

test('roles - assignRole()', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  const disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    roleId: MEMBER_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [invitorProject, inviteeProject] = projects

  assert.deepEqual(
    (await invitorProject.$member.getById(invitee.deviceId)).role,
    ROLES[MEMBER_ROLE_ID],
    'invitee has member role from invitor perspective'
  )

  assert.deepEqual(
    await inviteeProject.$getOwnRole(),
    ROLES[MEMBER_ROLE_ID],
    'invitee has member role from invitee perspective'
  )

  await t.test('invitor updates invitee role to coordinator', async () => {
    const roleRecordBefore = await invitorProject[kDataTypes].role.getByDocId(
      invitee.deviceId
    )

    await invitorProject.$member.assignRole(
      invitee.deviceId,
      COORDINATOR_ROLE_ID
    )

    const roleRecordAfter = await invitorProject[kDataTypes].role.getByDocId(
      invitee.deviceId
    )

    assert.deepEqual(
      roleRecordAfter.links,
      [roleRecordBefore.versionId],
      'role record links to record before role assignment'
    )
    assert.equal(roleRecordAfter.forks.length, 0, 'role record has no forks')

    await waitForSync(projects, 'initial')

    assert.deepEqual(
      (await invitorProject.$member.getById(invitee.deviceId)).role,
      ROLES[COORDINATOR_ROLE_ID],
      'invitee now has coordinator role from invitor perspective'
    )

    assert.deepEqual(
      await inviteeProject.$getOwnRole(),
      ROLES[COORDINATOR_ROLE_ID],
      'invitee now has coordinator role from invitee perspective'
    )
  })

  await t.test('invitee updates own role to member', async () => {
    const roleRecordBefore = await inviteeProject[kDataTypes].role.getByDocId(
      invitee.deviceId
    )

    await inviteeProject.$member.assignRole(invitee.deviceId, MEMBER_ROLE_ID)

    const roleRecordAfter = await inviteeProject[kDataTypes].role.getByDocId(
      invitee.deviceId
    )

    assert.deepEqual(
      roleRecordAfter.links,
      [roleRecordBefore.versionId],
      'role record from invitee links to record before role assignment'
    )
    assert.equal(
      roleRecordAfter.forks.length,
      0,
      'role record from invitee record has no forks'
    )

    await waitForSync(projects, 'initial')

    assert.deepEqual(
      (await invitorProject.$member.getById(invitee.deviceId)).role,
      ROLES[MEMBER_ROLE_ID],
      'invitee now has member role from invitor perspective'
    )

    assert.deepEqual(
      await inviteeProject.$getOwnRole(),
      ROLES[MEMBER_ROLE_ID],
      'invitee now has member role from invitee perspective'
    )
  })
})

test('roles - assignRole() with forked role', async (t) => {
  const managers = await createManagers(3, t)
  const [invitor, invitee1, invitee2] = managers
  let disconnectPeers = connectPeers(managers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  // 1. Invite both as coordinators

  await invite({
    invitor,
    projectId,
    invitees: [invitee1, invitee2],
    roleId: COORDINATOR_ROLE_ID,
  })

  const projects = await Promise.all(
    managers.map((m) => m.getProject(projectId))
  )

  const [invitorProject, invitee1Project] = projects

  await disconnectPeers()

  // 2. Create fork by two devices assigning a role to invitee2 while disconnected
  // TODO: Assign different roles and test fork resolution prefers the role with least power (code for this is not written yet)

  await invitorProject.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)
  await invitee1Project.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)

  disconnectPeers = connectPeers(managers)
  t.after(disconnectPeers)
  await waitForSync(projects, 'initial')

  // 3. Verify that invitee2 role is now forked

  const invitee2RoleForked = await invitee1Project[kDataTypes].role.getByDocId(
    invitee2.deviceId
  )
  assert.equal(invitee2RoleForked.forks.length, 1, 'invitee2 role has one fork')

  // 4. Assign role again, which should merge forked records

  await invitorProject.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)

  await waitForSync(projects, 'initial')

  const invitee2RoleMerged = await invitee1Project[kDataTypes].role.getByDocId(
    invitee2.deviceId
  )
  assert.equal(invitee2RoleMerged.forks.length, 0, 'invitee2 role has no forks')
})
