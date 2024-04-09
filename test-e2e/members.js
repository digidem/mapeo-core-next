// @ts-check
import { test } from 'brittle'
import { randomBytes } from 'crypto'

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
  disconnectPeers,
  invite,
  waitForPeers,
  waitForSync,
} from './utils.js'
import { kDataTypes } from '../src/mapeo-project.js'

test('getting yourself after creating project', async (t) => {
  const [manager] = await createManagers(1, t, 'tablet')

  const deviceInfo = manager.getDeviceInfo()
  const project = await manager.getProject(await manager.createProject())

  const me = await project.$member.getById(project.deviceId)

  t.alike(
    me,
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: CREATOR_ROLE,
    },
    'has expected member info with creator role'
  )

  const members = await project.$member.getMany()

  t.is(members.length, 1)
  t.alike(
    members[0],
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

  const me = await project.$member.getById(project.deviceId)

  t.alike(
    me,
    {
      deviceId: project.deviceId,
      deviceType: 'tablet',
      name: deviceInfo.name,
      role: NO_ROLE,
    },
    'has expected member info with no role'
  )

  const members = await project.$member.getMany()

  t.is(members.length, 1)
  t.alike(
    members[0],
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
  connectPeers(managers)
  await waitForPeers(managers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })
  const project = await invitor.getProject(projectId)

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    reject: true,
  })

  await t.exception(
    () => project.$member.getById(invitee.deviceId),
    'invited member cannot be retrieved'
  )

  const members = await project.$member.getMany()

  t.is(members.length, 1)
  t.absent(
    members.find((m) => m.deviceId === invitee.deviceId),
    'invited member not found'
  )
  await disconnectPeers(managers)
})

test('getting invited member after invite accepted', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  connectPeers(managers)
  await waitForPeers(managers)

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

  t.is(members.length, 2)

  const invitedMember = members.find((m) => m.deviceId === invitee.deviceId)

  t.alike(
    invitedMember,
    {
      deviceId: invitee.deviceId,
      deviceType: undefined,
      name: inviteeName,
      role: ROLES[MEMBER_ROLE_ID],
    },
    'has expected member info with member role'
  )

  // TODO: Test that device info of invited member can be read from invitor after syncing
  await disconnectPeers(managers)
})

test('invite uses custom role name when provided', async (t) => {
  t.plan(1)
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  connectPeers(managers)
  await waitForPeers(managers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  invitee.invite.on('invite-received', ({ roleName }) => {
    t.is(roleName, 'friend', 'roleName should be equal')
  })

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    roleName: 'friend',
    reject: true,
  })

  await disconnectPeers(managers)
})

test('invite uses default role name when not provided', async (t) => {
  t.plan(1)
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  connectPeers(managers)
  await waitForPeers(managers)

  const projectId = await invitor.createProject({ name: 'Mapeo' })

  invitee.invite.on('invite-received', ({ roleName }) => {
    t.is(
      roleName,
      ROLES[MEMBER_ROLE_ID].name,
      '`roleName` should use the fallback by deriving `roleId`'
    )
  })

  await invite({
    invitor,
    projectId,
    invitees: [invitee],
    reject: true,
  })

  await disconnectPeers(managers)
})

test('roles - creator role and role assignment', async (t) => {
  const [manager] = await createManagers(1, t)

  const projectId = await manager.createProject()
  const project = await manager.getProject(projectId)
  const ownRole = await project.$getOwnRole()

  t.alike(ownRole, CREATOR_ROLE, 'Project creator has creator role')

  const deviceId = randomBytes(32).toString('hex')
  await project.$member.assignRole(deviceId, MEMBER_ROLE_ID)

  const member = await project.$member.getById(deviceId)

  t.alike(member.role, ROLES[MEMBER_ROLE_ID], 'Can assign role to device')
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

  t.alike(
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
  await t.exception(async () => {
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

  t.alike(ownRole, CREATOR_ROLE, 'Project creator has creator role')

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

  t.alike(actual, expected, 'expected roles')
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

  t.alike(actual, expected, 'expected role')
})

test('roles - assignRole()', async (t) => {
  const managers = await createManagers(2, t)
  const [invitor, invitee] = managers
  connectPeers(managers)
  await waitForPeers(managers)

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

  t.alike(
    (await invitorProject.$member.getById(invitee.deviceId)).role,
    ROLES[MEMBER_ROLE_ID],
    'invitee has member role from invitor perspective'
  )

  t.alike(
    await inviteeProject.$getOwnRole(),
    ROLES[MEMBER_ROLE_ID],
    'invitee has member role from invitee perspective'
  )

  await t.test('invitor updates invitee role to coordinator', async (st) => {
    const roleRecordBefore = await invitorProject[
      kDataTypes
    ].membership.getByDocId(invitee.deviceId)

    await invitorProject.$member.assignRole(
      invitee.deviceId,
      COORDINATOR_ROLE_ID
    )

    const roleRecordAfter = await invitorProject[
      kDataTypes
    ].membership.getByDocId(invitee.deviceId)

    t.alike(
      roleRecordAfter.links,
      [roleRecordBefore.versionId],
      'role record links to record before role assignment'
    )
    t.is(roleRecordAfter.forks.length, 0, 'role record has no forks')

    await waitForSync(projects, 'initial')

    st.alike(
      (await invitorProject.$member.getById(invitee.deviceId)).role,
      ROLES[COORDINATOR_ROLE_ID],
      'invitee now has coordinator role from invitor perspective'
    )

    st.alike(
      await inviteeProject.$getOwnRole(),
      ROLES[COORDINATOR_ROLE_ID],
      'invitee now has coordinator role from invitee perspective'
    )
  })

  await t.test('invitee updates own role to member', async (st) => {
    const roleRecordBefore = await inviteeProject[
      kDataTypes
    ].membership.getByDocId(invitee.deviceId)

    await inviteeProject.$member.assignRole(invitee.deviceId, MEMBER_ROLE_ID)

    const roleRecordAfter = await inviteeProject[
      kDataTypes
    ].membership.getByDocId(invitee.deviceId)

    t.alike(
      roleRecordAfter.links,
      [roleRecordBefore.versionId],
      'role record from invitee links to record before role assignment'
    )
    t.is(
      roleRecordAfter.forks.length,
      0,
      'role record from invitee record has no forks'
    )

    await waitForSync(projects, 'initial')

    st.alike(
      (await invitorProject.$member.getById(invitee.deviceId)).role,
      ROLES[MEMBER_ROLE_ID],
      'invitee now has member role from invitor perspective'
    )

    st.alike(
      await inviteeProject.$getOwnRole(),
      ROLES[MEMBER_ROLE_ID],
      'invitee now has member role from invitee perspective'
    )
  })

  await disconnectPeers(managers)
})

test('roles - assignRole() with forked role', async (t) => {
  const managers = await createManagers(3, t)
  const [invitor, invitee1, invitee2] = managers
  connectPeers(managers)
  await waitForPeers(managers)

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

  await disconnectPeers(managers)

  // 2. Create fork by two devices assigning a role to invitee2 while disconnected
  // TODO: Assign different roles and test fork resolution prefers the role with least power (code for this is not written yet)

  await invitorProject.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)
  await invitee1Project.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)

  await connectPeers(managers)
  await waitForSync(projects, 'initial')

  // 3. Verify that invitee2 role is now forked

  const invitee2RoleForked = await invitee1Project[
    kDataTypes
  ].membership.getByDocId(invitee2.deviceId)
  t.is(invitee2RoleForked.forks.length, 1, 'invitee2 role has one fork')

  // 4. Assign role again, which should merge forked records

  await invitorProject.$member.assignRole(invitee2.deviceId, MEMBER_ROLE_ID)

  await waitForSync(projects, 'initial')

  const invitee2RoleMerged = await invitee1Project[
    kDataTypes
  ].membership.getByDocId(invitee2.deviceId)
  t.is(invitee2RoleMerged.forks.length, 0, 'invitee2 role has no forks')

  await disconnectPeers(managers)
})
