import test from 'brittle'

import getPort from 'get-port'
import createTestnet from '@hyperswarm/testnet'

import { createCoreKeyPair, createIdentityKeys } from './helpers/index.js'
import { Discovery } from '../lib/discovery.js'

test('discovery - dht/hyperswarm', async (t) => {
	t.plan(2)

	const testnet = await createTestnet(10)
	const bootstrap = testnet.bootstrap

	const keyPair = createCoreKeyPair('dht-peer-discovery')
	const key = keyPair.publicKey.toString('hex')

	const identity1 = createIdentityKeys()
	const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

	const identity2 = createIdentityKeys()
	const identityPublicKey2 = identity2.identityKeyPair.publicKey.toString('hex')

	const discover1 = new Discovery({
		port: await getPort(),
		keyPair: identity1.identityKeyPair,
		mdns: false,
		dht: { bootstrap, server: true, client: true }
	})

	const discover2 = new Discovery({
		port: await getPort(),
		keyPair: identity2.identityKeyPair,
		mdns: false,
		dht: { bootstrap, server: true, client: true }
	})

	discover1.on('peer', async (connection, peer) => {
		console.log('discover1')
		t.ok(peer.publicKey.toString('hex') === identityPublicKey2, 'match key of 2nd peer')
		await step()
	})

	discover2.on('peer', async (connection, peer) => {
		// console.log('discover2')
		t.ok(peer.publicKey.toString('hex') === identityPublicKey1, 'match key of 1st peer')
		await step()
	})

	let count = 0
	async function step () {
		count++
		if (count === 2) {
			await discover1.leave(keyPair.publicKey)
			await discover2.leave(keyPair.publicKey)
			await discover1.destroy()
			await discover2.destroy()
			await testnet.destroy()
		}
	}

	await discover1.join(keyPair.publicKey)
	await discover2.join(keyPair.publicKey)
})
