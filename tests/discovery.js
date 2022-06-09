import log from 'why-is-node-running'
import { test } from 'brittle'

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
		topic: keyPair.publicKey,
		port: await getPort(),
		identityKeyPair: identity1.identityKeyPair,
		mdns: false,
		dht: { bootstrap, server: true, client: true }
	})

	const discover2 = new Discovery({
		topic: keyPair.publicKey,
		port: await getPort(),
		identityKeyPair: identity2.identityKeyPair,
		mdns: false,
		dht: { bootstrap, server: true, client: true }
	})

	let count = 0
	discover1.on('peer', async (connection, peer) => {
		t.ok(peer.publicKey.toString('hex') === identityPublicKey2)
		await end()
	})

	discover2.on('peer', async (connection, peer) => {
		t.ok(peer.publicKey.toString('hex') === identityPublicKey1)
		await end()
	})

	await discover1.join()
	await discover2.join()

	async function end () {
		count++
		if (count === 2) {
			await discover1.leave()
			await discover2.leave()
			await discover1.destroy()
			await discover2.destroy()
			await testnet.destroy()

			t.end()
			// discover1.on('destroyed', () => {
			// 	discover2.on('destroyed', () => {
			// 		t.end()
			// 	})
			// })
		}
	}
})
