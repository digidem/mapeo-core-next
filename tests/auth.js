import test from 'brittle'
import Corestore from 'corestore'
import ram from 'random-access-memory'
import { KeyManager } from '@mapeo/crypto'

import { Authstore } from '../lib/auth.js'

function createIdentityKeypair () {
	const identityKey = KeyManager.generateIdentityKey()
	const km = new KeyManager(identityKey)
	return km.getIdentityKeypair()
}

test('auth', async (t) => {
	const adminKeypair = createIdentityKeypair()
	const adminPublicKey = adminKeypair.publicKey.toString('hex')

	const memberKeypair = createIdentityKeypair()
	const memberPublicKey = adminKeypair.publicKey.toString('hex')

	const store = new Corestore(ram, {
		primaryKey: adminKeypair.publicKey
	})

	const auth = new Authstore({
		store,
	})

	const adminCore = auth.get({
		name: 'adminName',
		keypair: adminKeypair,
		valueEncoding: 'json'
	})

	await adminCore.ready()

	const memberCore = auth.get({
		name: 'memberName',
		keypair: memberKeypair,
		valueEncoding: 'json'
	})

	await memberCore.ready()

	await adminCore.append([{
		identityKey: adminPublicKey, // TODO: maybe this property should be named publicKey?
		capability: 'admin'
	}])

	const capabilities = await auth.capabilities()

	t.ok(capabilities.length)
	t.is(capabilities[0].identityKey, adminPublicKey)
	t.is(capabilities[0].capability, 'admin')

	t.ok(await auth.isAdmin(adminPublicKey))

	await memberCore.append({
		identityKey: memberPublicKey,
		capability: 'member'
	})

	t.ok(await auth.isMember(memberPublicKey))
	t.not(await auth.isAdmin(memberPublicKey))
})
