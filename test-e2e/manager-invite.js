// @ts-check
import { test, skip } from 'brittle'
import { InviteResponse_Decision } from '../src/generated/rpc.js'
import { once } from 'node:events'
import {
  connectPeers,
  createManagers,
  disconnectPeers,
  waitForPeers,
} from './utils.js'
import { COORDINATOR_ROLE_ID, MEMBER_ROLE_ID } from '../src/roles.js'

/** @typedef {import('../src/generated/rpc.js').Invite} Invite */

test('member invite accepted', async (t) => {
  const [creator, joiner] = await createManagers(2, t)
  connectPeers([creator, joiner])
  await waitForPeers([creator, joiner])

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })
  const creatorProject = await creator.getProject(createdProjectId)

  await t.exception(
    async () => joiner.getProject(createdProjectId),
    'joiner cannot get project instance before being invited and added to project'
  )

  const responsePromise = creatorProject.$member.invite(joiner.deviceId, {
    roleId: MEMBER_ROLE_ID,
  })
  const [invite] = await once(joiner.invite, 'invite-received')
  t.is(typeof invite.inviteId, 'string', 'inviteId is string')
  t.ok(
    Buffer.from(invite.inviteId, 'hex').byteLength >= 32,
    'inviteId has at least 256 bits of entropy'
  )
  t.is(invite.projectName, 'Mapeo', 'project name of invite matches')

  await joiner.invite.accept(invite)

  t.is(
    await responsePromise,
    InviteResponse_Decision.ACCEPT,
    'correct invite response'
  )

  /// After invite flow has completed...

  t.alike(
    await joiner.listProjects(),
    await creator.listProjects(),
    'project info recorded in joiner successfully'
  )

  const joinerProject = await joiner.getProject(createdProjectId)

  t.alike(
    await joinerProject.$getProjectSettings(),
    await creatorProject.$getProjectSettings(),
    'Project settings match'
  )

  t.alike(
    await creatorProject.$member.getMany(),
    await joinerProject.$member.getMany(),
    'Project members match'
  )

  await disconnectPeers([creator, joiner])
})

test('chain of invites', async (t) => {
  const managers = await createManagers(4, t)
  const [creator, ...joiners] = managers
  connectPeers(managers)
  await waitForPeers(managers)

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })

  let invitor = creator
  for (const joiner of joiners) {
    const invitorProject = await invitor.getProject(createdProjectId)
    const responsePromise = invitorProject.$member.invite(joiner.deviceId, {
      roleId: COORDINATOR_ROLE_ID,
    })
    const [invite] = await once(joiner.invite, 'invite-received')
    await joiner.invite.accept(invite)
    t.is(
      await responsePromise,
      InviteResponse_Decision.ACCEPT,
      'correct invite response'
    )
  }

  /// After invite flow has completed...

  const creatorProject = await creator.getProject(createdProjectId)
  const expectedProjectSettings = await creatorProject.$getProjectSettings()
  const expectedMembers = await creatorProject.$member.getMany()

  for (const joiner of joiners) {
    const joinerProject = await joiner.getProject(createdProjectId)

    t.alike(
      await joinerProject.$getProjectSettings(),
      expectedProjectSettings,
      'Project settings match'
    )

    const joinerMembers = await joinerProject.$member.getMany()
    t.alike(
      joinerMembers.sort(memberSort),
      expectedMembers.sort(memberSort),
      'Project members match'
    )
  }

  await disconnectPeers(managers)
})

test('generates new invite IDs for each invite', async (t) => {
  const inviteCount = 10

  const [creator, joiner] = await createManagers(2, t)
  connectPeers([creator, joiner])
  t.teardown(() => disconnectPeers([creator, joiner]))
  await waitForPeers([creator, joiner])

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })
  const creatorProject = await creator.getProject(createdProjectId)

  /** @type {Array<string>} */
  const inviteIds = []

  for (let i = 0; i < inviteCount; i++) {
    const inviteReceivedPromise = once(joiner.invite, 'invite-received')
    const invitePromise = creatorProject.$member.invite(joiner.deviceId, {
      roleId: MEMBER_ROLE_ID,
    })
    const [invite] = await inviteReceivedPromise
    inviteIds.push(invite.inviteId)
    await joiner.invite.reject(invite)
    await invitePromise
  }

  t.is(
    new Set(inviteIds).size,
    inviteCount,
    `got ${inviteCount} unique invite IDs`
  )
})

// TODO: Needs fix to inviteApi to check role before sending invite
skip("member can't invite", async (t) => {
  const managers = await createManagers(3, t)
  const [creator, member, joiner] = managers
  connectPeers(managers)
  await waitForPeers(managers)

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })
  const creatorProject = await creator.getProject(createdProjectId)

  const responsePromise = creatorProject.$member.invite(member.deviceId, {
    roleId: MEMBER_ROLE_ID,
  })
  const [invite] = await once(member.invite, 'invite-received')
  await member.invite.accept(invite)
  await responsePromise

  /// After invite flow has completed...

  const memberProject = await member.getProject(createdProjectId)

  t.alike(
    await memberProject.$getProjectSettings(),
    await creatorProject.$getProjectSettings(),
    'Project settings match'
  )

  const exceptionPromise = t.exception(() =>
    memberProject.$member.invite(joiner.deviceId, {
      roleId: MEMBER_ROLE_ID,
    })
  )
  joiner.invite.once('invite-received', () => t.fail('should not send invite'))
  await exceptionPromise

  await disconnectPeers(managers)
})

test('member invite rejected', async (t) => {
  const [creator, joiner] = await createManagers(2, t)
  connectPeers([creator, joiner])
  await waitForPeers([creator, joiner])

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })
  const creatorProject = await creator.getProject(createdProjectId)

  await t.exception(
    async () => joiner.getProject(createdProjectId),
    'joiner cannot get project instance before being invited and added to project'
  )

  const responsePromise = creatorProject.$member.invite(joiner.deviceId, {
    roleId: MEMBER_ROLE_ID,
  })
  const [invite] = await once(joiner.invite, 'invite-received')

  await joiner.invite.reject(invite)

  t.is(
    await responsePromise,
    InviteResponse_Decision.REJECT,
    'correct invite response'
  )

  /// After invite flow has completed...

  const joinerListedProjects = await joiner.listProjects()

  t.is(joinerListedProjects.length, 0, 'project not added to joiner')

  await t.exception(
    async () => joiner.getProject(createdProjectId),
    'joiner cannot get project instance'
  )

  t.is(
    (await creatorProject.$member.getMany()).length,
    1,
    'Only 1 member in project still'
  )

  await disconnectPeers([creator, joiner])
})

test('cancelation', async (t) => {
  const [creator, joiner] = await createManagers(2, t)
  connectPeers([creator, joiner])
  t.teardown(() => disconnectPeers([creator, joiner]))
  await waitForPeers([creator, joiner])

  const createdProjectId = await creator.createProject({ name: 'Mapeo' })
  const creatorProject = await creator.getProject(createdProjectId)

  const inviteReceivedPromise = once(joiner.invite, 'invite-received')
  const inviteRemovedPromise = once(joiner.invite, 'invite-removed')

  const abortController = new AbortController()

  const invitePromise = creatorProject.$member.invite(joiner.deviceId, {
    roleId: MEMBER_ROLE_ID,
    signal: abortController.signal,
  })
  const inviteAbortedAssertionPromise = t.exception(
    invitePromise,
    /Invite aborted/,
    'should throw after being aborted'
  )

  const [invite] = await inviteReceivedPromise

  abortController.abort()
  await inviteAbortedAssertionPromise

  const [canceledInvite, removalReason] = await inviteRemovedPromise

  t.alike(
    invite.inviteId,
    canceledInvite.inviteId,
    'removed invite has correct ID'
  )
  t.is(removalReason, 'canceled')
})

/**
 * @param {import('../src/member-api.js').MemberInfo} a
 * @param {import('../src/member-api.js').MemberInfo} b
 */
function memberSort(a, b) {
  if (a.deviceId < b.deviceId) return -1
  if (a.deviceId > b.deviceId) return 1
  return 0
}
