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
		keyPair: identityKeyPair
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

	// assign capabilities to member
	const capabilitiesCore = admin.authstore.get({
		keyPair: admin.identityKeyPair,
		valueEncoding: 'json'
	})

	await capabilitiesCore.ready()

	await capabilitiesCore.append({
		capability: 'admin',
		identityPublicKey: admin.identityKeyPair.publicKey.toString('hex')
	})

	await capabilitiesCore.append({
		capability: 'member',
		identityPublicKey: member.identityKeyPair.publicKey.toString('hex')
	})

  // see if capabilities statements exist
	const capabilities = await admin.authstore.capabilities()
	t.ok(capabilities.length === 4)

	// test isMember and isAdmin on both authstores for both users
	t.ok(await admin.authstore.isMember(member.identityKeyPair.publicKey.toString('hex')))
	t.not(await admin.authstore.isAdmin(member.identityKeyPair.publicKey.toString('hex')))
	t.not(await member.authstore.isMember(admin.identityKeyPair.publicKey.toString('hex'))) // TODO: maybe this should actually be true
	t.ok(await member.authstore.isAdmin(admin.identityKeyPair.publicKey.toString('hex')))
})
