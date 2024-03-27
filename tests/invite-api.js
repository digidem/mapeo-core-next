// @ts-check
import test from 'brittle'
import { once } from 'node:events'
import { compact, concat, map, every } from 'iterpal'
import { onTimes } from './helpers/events.js'
import { randomBytes } from 'crypto'
import { KeyManager } from '@mapeo/crypto'
import { LocalPeers } from '../src/local-peers.js'
import { InviteApi } from '../src/invite-api.js'
import { keyToId, projectKeyToPublicId } from '../src/utils.js'
import { InviteResponse_Decision } from '../src/generated/rpc.js'

/** @typedef {import('../src/generated/rpc.js').Invite} Invite */
/** @typedef {import('../src/generated/rpc.js').InviteResponse} InviteResponse */

class MockLocalPeers extends LocalPeers {
  /**
   * @param {string} deviceId
   * @param {InviteResponse} inviteResponse
   */
  async sendInviteResponse(deviceId, inviteResponse) {
    this.emit('invite-response', deviceId, inviteResponse)
  }
}

test('has no invites to start', (t) => {
  const { rpc } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not be called')
      },
    },
  })

  t.alike(inviteApi.getPending(), [])
})

test('invite-received event has expected payload', async (t) => {
  const { rpc, invitorPeerId, projectPublicId } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not be called')
      },
    },
  })

  const invitesReceivedPromise = onTimes(inviteApi, 'invite-received', 3)

  const projectName = 'My Project'
  const bareInvite = {
    inviteId: randomBytes(32),
    projectPublicId,
    projectName,
    invitorName: 'Your Friend',
  }
  rpc.emit('invite', invitorPeerId, bareInvite)

  const partialInvite = {
    ...bareInvite,
    inviteId: randomBytes(32),
    roleDescription: 'Cool Role',
  }
  rpc.emit('invite', invitorPeerId, partialInvite)

  const fullInvite = {
    ...bareInvite,
    inviteId: randomBytes(32),
    roleName: 'Superfan',
    roleDescription: 'This Cool Role',
  }
  rpc.emit('invite', invitorPeerId, fullInvite)

  const expectedInvites = [
    {
      inviteId: bareInvite.inviteId.toString('hex'),
      projectPublicId,
      projectName,
      invitorName: 'Your Friend',
    },
    {
      inviteId: partialInvite.inviteId.toString('hex'),
      projectPublicId,
      projectName,
      roleDescription: 'Cool Role',
      invitorName: 'Your Friend',
    },
    {
      inviteId: fullInvite.inviteId.toString('hex'),
      projectPublicId,
      projectName,
      roleName: 'Superfan',
      roleDescription: 'This Cool Role',
      invitorName: 'Your Friend',
    },
  ]
  const receivedInvitesArgs = await invitesReceivedPromise
  assertInvitesAlike(
    t,
    receivedInvitesArgs,
    expectedInvites,
    'received expected invites'
  )
  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    expectedInvites,
    'pending invites are expected'
  )
})

test('Accept invite', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  /** @type {Array<Buffer>} */
  const projectKeysFound = []

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async ({ projectKey }) => {
        projectKeysFound.push(projectKey)
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')
  const inviteRemovedPromise = once(inviteApi, 'invite-removed')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has one pending invite'
  )

  // Invitor: prepare to share project join details upon acceptance

  rpc.once('invite-response', (peerId, inviteResponse) => {
    t.is(
      peerId,
      invitorPeerId,
      'received an invite response from the correct peer'
    )
    t.alike(
      inviteResponse.inviteId,
      invite.inviteId,
      'received an invite response to this invite'
    )
    t.is(
      inviteResponse.decision,
      InviteResponse_Decision.ACCEPT,
      'received an accept'
    )

    rpc.emit('got-project-details', invitorPeerId, {
      inviteId: invite.inviteId,
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: accept

  await inviteApi.accept(inviteExternal)

  t.ok(
    projectKeysFound.some((k) => k.equals(projectKey)),
    'added to project'
  )

  const [removedInvite] = await inviteRemovedPromise
  assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
  assertInvitesAlike(t, inviteApi.getPending(), [], 'no invites remain')
})

test('Reject invite', async (t) => {
  const { rpc, invitorPeerId, invite, inviteExternal } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not add project')
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has one pending invite'
  )

  // Invitor: prepare to receive response

  const inviteResponseEventPromise = once(rpc, 'invite-response')

  // Invitee: reject

  const inviteRemovedPromise = once(inviteApi, 'invite-removed')

  inviteApi.reject(inviteExternal)

  const [removedInvite] = await inviteRemovedPromise
  assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
  assertInvitesAlike(t, inviteApi.getPending(), [], 'pending invites removed')

  // Invitor: check rejection

  const [inviteResponsePeerId, inviteResponse] =
    await inviteResponseEventPromise
  t.is(inviteResponsePeerId, invitorPeerId, 'got response from right peer')
  t.alike(
    inviteResponse.inviteId,
    invite.inviteId,
    'got response for the right invite'
  )
  t.is(inviteResponse.decision, InviteResponse_Decision.REJECT, 'got rejection')
})

test('Receiving invite for project that peer already belongs to', async (t) => {
  t.test('was member prior to connection', async (t) => {
    const { rpc, invitorPeerId, projectPublicId, invite } = setup()

    const inviteApi = new InviteApi({
      rpc,
      queries: {
        isMember: (p) => p === projectPublicId,
        addProject: async () => {
          t.fail('should not add project')
        },
      },
    })

    inviteApi.on('invite-received', () => {
      t.fail('should not emit a received invite')
    })

    // Invitor: prepare to receive response

    const inviteResponseEventPromise = once(rpc, 'invite-response')

    // Invitor: send the invite

    rpc.emit('invite', invitorPeerId, invite)

    assertInvitesAlike(t, inviteApi.getPending(), [], 'has no pending invites')

    // Invitor: check invite response

    const [inviteResponsePeerId, inviteResponse] =
      await inviteResponseEventPromise
    t.is(inviteResponsePeerId, invitorPeerId, 'got response from right peer')
    t.alike(
      inviteResponse.inviteId,
      invite.inviteId,
      'got response to right invite'
    )
    t.is(
      inviteResponse.decision,
      InviteResponse_Decision.ALREADY,
      'got "already" response'
    )

    assertInvitesAlike(t, inviteApi.getPending(), [], 'has no pending invites')
  })

  t.test(
    'became member (somehow!) between receiving invite and accepting',
    async (t) => {
      const { rpc, invitorPeerId, invite, inviteExternal } = setup()

      let isMember = false

      const inviteApi = new InviteApi({
        rpc,
        queries: {
          isMember: () => isMember,
          addProject: async () => {
            t.fail('should not add project')
          },
        },
      })

      const inviteReceivedPromise = once(inviteApi, 'invite-received')

      // Invitor: send the invite

      rpc.emit('invite', invitorPeerId, invite)

      // Invitee: receive the invite, then get (somehow) added

      await inviteReceivedPromise

      assertInvitesAlike(
        t,
        inviteApi.getPending(),
        [inviteExternal],
        'has a pending invite'
      )

      isMember = true

      // Invitor: prepare to receive response

      const inviteResponseEventPromise = once(rpc, 'invite-response')

      // Invitee: attempt accept, which should send a rejection

      const inviteRemovedPromise = once(inviteApi, 'invite-removed')

      await inviteApi.accept(inviteExternal)

      const [removedInvite] = await inviteRemovedPromise
      assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
      assertInvitesAlike(
        t,
        inviteApi.getPending(),
        [],
        'has no pending invites'
      )

      // Invitor: check invite response

      const [inviteResponsePeerId, inviteResponse] =
        await inviteResponseEventPromise
      t.is(inviteResponsePeerId, invitorPeerId)
      t.alike(inviteResponse.inviteId, invite.inviteId)
      t.is(inviteResponse.decision, InviteResponse_Decision.ALREADY)
    }
  )

  t.test('became member from accepting another invite', async (t) => {
    const {
      rpc,
      invitorPeerId: invitor1PeerId,
      invite,
      inviteExternal,
      projectKey,
      encryptionKeys,
    } = setup()

    /** @type {undefined | Buffer} */
    let projectKeyAdded
    const inviteApi = new InviteApi({
      rpc,
      queries: {
        isMember: () => false,
        addProject: async ({ projectKey }) => {
          t.absent(projectKeyAdded, 'only adds one project')
          projectKeyAdded = projectKey
        },
      },
    })

    const invitesReceivedPromise = onTimes(inviteApi, 'invite-received', 6)

    // Invitor 1: send two invites to the project

    rpc.emit('invite', invitor1PeerId, invite)

    const secondInviteFromPeer1 = { ...invite, inviteId: randomBytes(32) }
    const secondInviteExternalFromPeer1 = {
      ...inviteExternal,
      inviteId: secondInviteFromPeer1.inviteId.toString('hex'),
    }
    rpc.emit('invite', invitor1PeerId, secondInviteFromPeer1)

    // Invitor 2: send two invites to the project

    const { invitorPeerId: invitor2PeerId } = setup()
    const firstInviteFromPeer2 = { ...invite, inviteId: randomBytes(32) }
    const firstInviteExternalFromPeer2 = {
      ...inviteExternal,
      inviteId: firstInviteFromPeer2.inviteId.toString('hex'),
    }
    const secondInviteFromPeer2 = { ...invite, inviteId: randomBytes(32) }
    const secondInviteExternalFromPeer2 = {
      ...inviteExternal,
      inviteId: secondInviteFromPeer2.inviteId.toString('hex'),
    }
    rpc.emit('invite', invitor2PeerId, firstInviteFromPeer2)
    rpc.emit('invite', invitor2PeerId, secondInviteFromPeer2)

    // Invitor 3: send one invite to the project and another to a different project

    const {
      invitorPeerId: invitor3PeerId,
      invite: unrelatedInvite,
      inviteExternal: unrelatedInviteExternal,
    } = setup()
    const firstInviteFromPeer3 = { ...invite, inviteId: randomBytes(32) }
    const firstInviteExternalFromPeer3 = {
      ...inviteExternal,
      inviteId: firstInviteFromPeer3.inviteId.toString('hex'),
    }
    rpc.emit('invite', invitor3PeerId, firstInviteFromPeer3)
    rpc.emit('invite', invitor3PeerId, unrelatedInvite)

    // Invitee: receive the invites

    await invitesReceivedPromise

    assertInvitesAlike(
      t,
      inviteApi.getPending(),
      [
        inviteExternal,
        secondInviteExternalFromPeer1,
        firstInviteExternalFromPeer2,
        secondInviteExternalFromPeer2,
        firstInviteExternalFromPeer3,
        unrelatedInviteExternal,
      ],
      'has six pending invites'
    )

    // Invitors: handle invite responses

    /** @type {Set<{ peerId: string, inviteResponse: InviteResponse }>} */
    const responses = new Set()
    rpc.on('invite-response', (peerId, inviteResponse) => {
      responses.add({ peerId, inviteResponse })
      if (
        peerId === invitor1PeerId &&
        inviteResponse.inviteId.equals(invite.inviteId)
      ) {
        t.is(inviteResponse.decision, InviteResponse_Decision.ACCEPT)
        rpc.emit('got-project-details', invitor1PeerId, {
          inviteId: invite.inviteId,
          projectKey,
          encryptionKeys,
        })
      } else {
        t.is(inviteResponse.decision, InviteResponse_Decision.ALREADY)
      }
    })

    // Invitee: accept an invite

    const invitesRemovedPromise = onTimes(inviteApi, 'invite-removed', 5)

    await inviteApi.accept(inviteExternal)

    t.alike(
      responses,
      new Set([
        {
          peerId: invitor1PeerId,
          inviteResponse: {
            inviteId: invite.inviteId,
            decision: InviteResponse_Decision.ACCEPT,
          },
        },
        {
          peerId: invitor1PeerId,
          inviteResponse: {
            inviteId: secondInviteFromPeer1.inviteId,
            decision: InviteResponse_Decision.ALREADY,
          },
        },
        {
          peerId: invitor2PeerId,
          inviteResponse: {
            inviteId: firstInviteFromPeer2.inviteId,
            decision: InviteResponse_Decision.ALREADY,
          },
        },
        {
          peerId: invitor2PeerId,
          inviteResponse: {
            inviteId: secondInviteFromPeer2.inviteId,
            decision: InviteResponse_Decision.ALREADY,
          },
        },
        {
          peerId: invitor3PeerId,
          inviteResponse: {
            inviteId: firstInviteFromPeer3.inviteId,
            decision: InviteResponse_Decision.ALREADY,
          },
        },
      ]),
      'got expected responses'
    )

    const removedInvites = await invitesRemovedPromise
    const allButLastRemoved = removedInvites.slice(0, -1)
    const lastRemoved = removedInvites[removedInvites.length - 1]
    assertInvitesAlike(
      t,
      new Set(allButLastRemoved),
      new Set([
        secondInviteExternalFromPeer1,
        firstInviteExternalFromPeer2,
        secondInviteExternalFromPeer2,
        firstInviteExternalFromPeer3,
      ]),
      'other invites are removed first, to avoid UI jitter'
    )
    assertInvitesAlike(
      t,
      lastRemoved,
      inviteExternal,
      'accepted invite was removed last, to avoid UI jitter'
    )
    assertInvitesAlike(
      t,
      inviteApi.getPending(),
      [unrelatedInviteExternal],
      'unaffected invites stick around'
    )
  })
})

test('trying to accept or reject non-existent invite throws', async (t) => {
  const { rpc, inviteExternal } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {},
    },
  })

  inviteApi.on('invite-received', () => {
    t.fail('should not emit an "added" event')
  })
  inviteApi.on('invite-removed', () => {
    t.fail('should not emit an "removed" event')
  })

  await t.exception(inviteApi.accept(inviteExternal))
  t.exception(() => inviteApi.reject(inviteExternal))

  assertInvitesAlike(t, inviteApi.getPending(), [], 'has no pending invites')
})

test('throws when quickly double-accepting the same invite', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  /** @type {Array<Buffer>} */
  const projectKeysFound = []
  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async ({ projectKey }) => {
        projectKeysFound.push(projectKey)
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  // Invitor: prepare to share project join details upon acceptance

  let inviteResponseCount = 0
  rpc.on('invite-response', (_peerId, inviteResponse) => {
    inviteResponseCount++

    t.alike(
      inviteResponse.inviteId,
      invite.inviteId,
      'responds to the correct invite'
    )

    rpc.emit('got-project-details', invitorPeerId, {
      inviteId: invite.inviteId,
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: accept twice

  const firstAcceptPromise = inviteApi.accept(inviteExternal)

  await t.exception(inviteApi.accept(inviteExternal), 'second accept fails')

  await firstAcceptPromise
  t.ok(
    projectKeysFound.some((k) => k.equals(projectKey)),
    'added to project'
  )
  t.is(inviteResponseCount, 1, 'only sent one invite response')
})

test('throws when quickly accepting and then rejecting an invite', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  /** @type {Array<Buffer>} */
  const projectKeysFound = []
  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async ({ projectKey }) => {
        projectKeysFound.push(projectKey)
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  // Invitor: prepare to share project join details upon acceptance

  rpc.on('invite-response', () => {
    rpc.emit('got-project-details', invitorPeerId, {
      inviteId: invite.inviteId,
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: accept then reject

  const acceptPromise = inviteApi.accept(inviteExternal)

  t.exception(() => inviteApi.reject(inviteExternal), 'reject fails')

  await acceptPromise
})

test('throws when quickly accepting two invites for the same project', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite: invite1,
    inviteExternal: invite1External,
    projectKey,
    encryptionKeys,
  } = setup()
  const invite2External = {
    ...invite1External,
    inviteId: randomBytes(32).toString('hex'),
  }

  /** @type {Array<Buffer>} */
  const projectKeysFound = []
  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async ({ projectKey }) => {
        projectKeysFound.push(projectKey)
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite1)

  // Invitee: receive the invite

  await inviteReceivedPromise

  // Invitor: prepare to share project join details upon acceptance

  let inviteResponseCount = 0
  rpc.on('invite-response', (_peerId, inviteResponse) => {
    inviteResponseCount++

    t.alike(
      inviteResponse.inviteId,
      invite1.inviteId,
      'responds to the correct invite'
    )

    rpc.emit('got-project-details', invitorPeerId, {
      inviteId: invite1.inviteId,
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: accept twice

  const firstAcceptPromise = inviteApi.accept(invite1External)

  await t.exception(inviteApi.accept(invite2External), 'second accept fails')

  await firstAcceptPromise
  t.ok(
    projectKeysFound.some((k) => k.equals(projectKey)),
    'added to project'
  )
  t.is(inviteResponseCount, 1, 'only sent one invite response')
})

test('receiving project join details from an unknown peer is a no-op', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not be called')
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has one pending invite'
  )

  // Invitor: prepare to share project join details with the wrong invite ID

  rpc.once('invite-response', () => {
    const { invitorPeerId: bogusPeerId } = setup()
    rpc.emit('got-project-details', bogusPeerId, {
      inviteId: invite.inviteId,
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: try to accept

  inviteApi.accept(inviteExternal)

  // Send and reject another invite

  const { invite: invite2, inviteExternal: invite2External } = setup()
  const invite2ReceivedPromise = once(inviteApi, 'invite-received')
  rpc.emit('invite', invitorPeerId, invite2)
  await invite2ReceivedPromise
  const invite2RemovedPromise = once(inviteApi, 'invite-removed')
  inviteApi.reject(invite2External)
  await invite2RemovedPromise

  // The original invite should still be around

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has original pending invite'
  )
})

test('receiving project join details for an unknown invite ID is a no-op', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not be called')
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has one pending invite'
  )

  // Invitor: prepare to share project join details with the wrong invite ID

  rpc.once('invite-response', () => {
    rpc.emit('got-project-details', invitorPeerId, {
      inviteId: randomBytes(32),
      projectKey,
      encryptionKeys,
    })
  })

  // Invitee: try to accept

  inviteApi.accept(inviteExternal)

  // Send and reject another invite

  const { invite: invite2, inviteExternal: invite2External } = setup()
  const invite2ReceivedPromise = once(inviteApi, 'invite-received')
  rpc.emit('invite', invitorPeerId, invite2)
  await invite2ReceivedPromise
  const invite2RemovedPromise = once(inviteApi, 'invite-removed')
  inviteApi.reject(invite2External)
  await invite2RemovedPromise

  // The original invite should still be around

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has original pending invite'
  )
})

test('ignores duplicate invite IDs', async (t) => {
  const { rpc, invitorPeerId, invite } = setup()
  const { invite: invite2 } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {},
    },
  })

  const twoInvitesPromise = onTimes(inviteApi, 'invite-received', 2)

  for (let i = 0; i < 100; i++) rpc.emit('invite', invitorPeerId, invite)
  rpc.emit('invite', invitorPeerId, invite2)

  await twoInvitesPromise

  const invites = inviteApi.getPending()
  t.is(invites.length, 2, 'two invites')
  const inviteIds = invites.map((i) => i.inviteId)
  t.unlike(inviteIds[0], inviteIds[1], 'got different invite IDs')
})

test('failures to send acceptances cause accept to reject, no project to be added, and invite to be removed', async (t) => {
  const { rpc, invitorPeerId, invite, inviteExternal } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not try to add project if could not accept')
      },
    },
  })

  let acceptsAttempted = 0
  rpc.sendInviteResponse = async (deviceId, inviteResponse) => {
    t.is(deviceId, invitorPeerId)
    t.is(inviteResponse.decision, InviteResponse_Decision.ACCEPT)
    acceptsAttempted++
    throw new Error('Failed to accept invite')
  }

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive and try to accept the invite

  const inviteRemovedPromise = once(inviteApi, 'invite-removed')

  await inviteReceivedPromise

  assertInvitesAlike(
    t,
    inviteApi.getPending(),
    [inviteExternal],
    'has a pending invite'
  )

  await t.exception(inviteApi.accept(inviteExternal), 'fails to accept')

  t.is(acceptsAttempted, 1)
  const [removedInvite] = await inviteRemovedPromise
  assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
  assertInvitesAlike(t, inviteApi.getPending(), [], 'has no pending invites')
})

test('failures to send rejections are ignored, but invite is still removed', async (t) => {
  const { rpc, invitorPeerId, invite, inviteExternal } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        t.fail('should not add project')
      },
    },
  })

  let rejectionsAttempted = 0
  rpc.sendInviteResponse = async (deviceId, inviteResponse) => {
    t.is(deviceId, invitorPeerId)
    t.is(inviteResponse.decision, InviteResponse_Decision.REJECT)
    rejectionsAttempted++
    throw new Error('Failed to reject invite')
  }

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive and reject the invite

  const inviteRemovedPromise = once(inviteApi, 'invite-removed')

  await inviteReceivedPromise
  t.execution(() => inviteApi.reject(inviteExternal))

  t.is(rejectionsAttempted, 1)
  const [removedInvite] = await inviteRemovedPromise
  assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
})

test('failures to add project cause accept() to reject and invite to be removed', async (t) => {
  const {
    rpc,
    invitorPeerId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  } = setup()

  const inviteApi = new InviteApi({
    rpc,
    queries: {
      isMember: () => false,
      addProject: async () => {
        throw new Error('Failed to add project')
      },
    },
  })

  const inviteReceivedPromise = once(inviteApi, 'invite-received')

  // Invitor: send the invite

  rpc.emit('invite', invitorPeerId, invite)

  // Invitee: receive the invite

  await inviteReceivedPromise

  // Invitor: prepare to share project join details upon acceptance

  rpc.once('invite-response', (peerId, inviteResponse) => {
    if (
      peerId === invitorPeerId &&
      inviteResponse.inviteId.equals(invite.inviteId) &&
      inviteResponse.decision === InviteResponse_Decision.ACCEPT
    ) {
      rpc.emit('got-project-details', invitorPeerId, {
        inviteId: invite.inviteId,
        projectKey,
        encryptionKeys,
      })
    }
  })

  // Invitee: try to accept

  const inviteRemovedPromise = once(inviteApi, 'invite-removed')

  await t.exception(inviteApi.accept(inviteExternal), 'accept should fail')

  const [removedInvite] = await inviteRemovedPromise
  assertInvitesAlike(t, removedInvite, inviteExternal, 'invite was removed')
})

function setup() {
  const encryptionKeys = { auth: randomBytes(32) }
  const projectKey = KeyManager.generateProjectKeypair().publicKey

  const projectPublicId = projectKeyToPublicId(projectKey)
  const invite = {
    inviteId: randomBytes(32),
    projectPublicId,
    projectName: 'Mapeo Project',
    roleName: 'Superfan',
    invitorName: 'Host',
  }
  const inviteExternal = {
    ...invite,
    inviteId: invite.inviteId.toString('hex'),
  }

  const invitorPeerId = keyToId(randomBytes(16))
  const rpc = new MockLocalPeers()

  return {
    rpc,
    invitorPeerId,
    projectPublicId,
    invite,
    inviteExternal,
    projectKey,
    encryptionKeys,
  }
}

/**
 * Assert that invites are alike, allowing for some wiggle room around
 * "received at" timestamps.
 *
 * @param {import('brittle').TestInstance} t
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 * @returns {void}
 */
function assertInvitesAlike(t, actual, expected, message) {
  t.alike(removeReceivedAt(actual), removeReceivedAt(expected), message)

  const allReceivedAts = concat(
    getReceivedAts(actual),
    getReceivedAts(expected)
  )
  const now = Date.now()
  t.ok(
    every(
      allReceivedAts,
      (receivedAt) => receivedAt > now - 30_000 && receivedAt <= now
    ),
    message
  )
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function removeReceivedAt(value) {
  if (typeof value !== 'object' || !value) return value

  if (Array.isArray(value)) return value.map(removeReceivedAt)

  if (value instanceof Set) return new Set(map(value, removeReceivedAt))

  if ('receivedAt' in value) {
    const { receivedAt: _, ...result } = value
    return result
  }

  return value
}

/**
 * @param {unknown} value
 * @returns {Iterable<number>}
 */
function getReceivedAts(value) {
  const asIterable =
    Array.isArray(value) || value instanceof Set ? value : [value]
  const recievedAts = map(asIterable, getReceivedAt)
  return compact(recievedAts)
}

/**
 * @param {unknown} value
 * @returns {null | number}
 */
function getReceivedAt(value) {
  return typeof value === 'object' &&
    value &&
    'receivedAt' in value &&
    typeof value.receivedAt === 'number'
    ? value.receivedAt
    : null
}
