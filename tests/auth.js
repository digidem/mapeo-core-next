import test from 'brittle'
import Corestore from 'corestore'
import ram from 'random-access-memory'
import { KeyManager } from '@mapeo/crypto'

import { Authstore } from '../lib/auth.js'

// a project will have setup code similar to this function
function createAuthstore () {
	const identityKey = KeyManager.generateIdentityKey()
	const keyManager = new KeyManager(identityKey)
	const identityKeyPair = keyManager.getIdentityKeypair()

	const store = new Corestore(ram, {
		primaryKey: identityKeyPair.publicKey
	})

	const authstore = new Authstore({
		store,
		keyPair: identityKeyPair,
		capabilities: ['none', 'member', 'admin'] // TODO: it seems there could be a different way of modeling these capabilities rather than just an array
	})

	return {
		authstore,
		store,
		identityKeyPair,
		keyManager,
		identityKey
	}
}

test('auth', async (t) => {
	const admin = createAuthstore()
	const member = createAuthstore()

	await admin.authstore.ready()
	await member.authstore.ready()

	const adminStream = admin.authstore.replicate(true, { live: true })
	const memberStream = member.authstore.replicate(false, { live: true })

	adminStream.pipe(memberStream).pipe(adminStream)	

	// Test that ownership statements have the right public keys
	const adminOwnershipStatement = await admin.authstore.getOwnershipStatement()
	const memberOwnershipStatement = await member.authstore.getOwnershipStatement()

	t.ok(adminOwnershipStatement.identityPublicKey.toString('hex'), admin.identityKeyPair.publicKey.toString('hex'))
	t.ok(memberOwnershipStatement.identityPublicKey.toString('hex'), member.identityKeyPair.publicKey.toString('hex'))

	// Test that we can assert the ownership of a remote capabilities core
	// From a member authstore
	{
		const adminRemoteIdentityCore = member.authstore.get(admin.identityKeyPair.publicKey)
		const statement= await adminRemoteIdentityCore.get(0, { valueEncoding: 'json' })
		t.ok(statement.identityPublicKey, admin.identityKeyPair.publicKey.toString('hex'))
	}

	// ... and from an admin authstore	
	{
		const memberRemoteIdentityCore = admin.authstore.get(member.identityKeyPair.publicKey)
		const statement= await memberRemoteIdentityCore.get(0, { valueEncoding: 'json' })
		t.ok(statement.identityPublicKey, member.identityKeyPair.publicKey.toString('hex'))
	}

	// each authstore should have 2 cores at this point
	t.ok(admin.authstore.cores.size === 2)
	t.ok(member.authstore.cores.size === 2)

	await admin.authstore.append({
		identityPublicKey: admin.identityKeyPair.publicKey.toString('hex'),
		capability: 'admin'
	})

	await admin.authstore.append({
		identityPublicKey: member.identityKeyPair.publicKey.toString('hex'),
		capability: 'member'
	})

	await admin.authstore.append({
		identityPublicKey: member.identityKeyPair.publicKey.toString('hex'),
		capability: 'none'
	})

	// admin should have admin capability
	{
		const access = await admin.authstore.hasCapability({
			identityPublicKey: admin.identityKeyPair.publicKey.toString('hex'),
			capability: 'admin'
		})

		t.ok(access === true)
	}

	// admin should have member capability
	{
		const access = await admin.authstore.hasCapability({
			identityPublicKey: admin.identityKeyPair.publicKey.toString('hex'),
			capability: 'member'
		})

		t.ok(access === true)
	}

	// member should not have admin capability (they were banned)
	{
		const access = await admin.authstore.hasCapability({
			identityPublicKey: member.identityKeyPair.publicKey.toString('hex'),
			capability: 'admin'
		})

		t.ok(access === false)
	}

	// member should not have member capability (they were banned)
	{
		const access = await admin.authstore.hasCapability({
			identityPublicKey: member.identityKeyPair.publicKey.toString('hex'),
			capability: 'member'
		})

		t.ok(access === false)
	}

	// check if member is banned (capability of none)
	// TODO: it seems there could be a different way of modeling these capabilities rather than just an array
	{
		const isBanned = await admin.authstore.hasCapability({
			identityPublicKey: member.identityKeyPair.publicKey.toString('hex'),
			capability: 'none'
		})

		t.ok(isBanned === true)
	}
})
