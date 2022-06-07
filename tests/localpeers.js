import { test } from 'brittle'

import { createCoreKeyPair, createIdentityKeys } from './helpers/index.js'
import { MdnsPeerDiscovery } from '../lib/localpeers.js'

test('mdns peer discovery: connect two peers', async (t) => {
	t.plan(8)

	const keyPair = createCoreKeyPair('mdns-peer-discovery1')
	const key = keyPair.publicKey.toString('hex')

	const identity1 = createIdentityKeys()
	const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

	const identity2 = createIdentityKeys()
	const identityPublicKey2 = identity2.identityKeyPair.publicKey.toString('hex')

	const discover1 = new MdnsPeerDiscovery({
		name: 'mapeo',
		topic: key,
		identityKeyPair: identity1.identityKeyPair,
		port: 4567,
	})

	const discover2 = new MdnsPeerDiscovery({
		name: 'mapeo',
		topic: key,
		identityKeyPair: identity2.identityKeyPair,
		port: 5678,
	})

	let count = 0
	discover1.on('connection', (connection, peer) => {
		t.ok(peer.topic === key)
		t.ok(Buffer.from(peer.topic, 'hex').equals(keyPair.publicKey))
		t.ok(peer.identityPublicKey == identityPublicKey2)
		t.ok(Buffer.from(peer.identityPublicKey, 'hex').equals(identity2.identityKeyPair.publicKey))
		end()
	})

	discover2.on('connection', (connection, peer) => {
		t.ok(peer.topic === key)
		t.ok(Buffer.from(peer.topic, 'hex').equals(keyPair.publicKey))
		t.ok(peer.identityPublicKey == identityPublicKey1)
		t.ok(Buffer.from(peer.identityPublicKey, 'hex').equals(identity1.identityKeyPair.publicKey))
		end()
	})

	function end () {
		count++
		if (count === 2) {
			discover1.destroy()
			discover2.destroy()

			discover1.on('destroyed', () => {
				discover2.on('destroyed', () => {
					t.end()
				})
			})
		}
	}
})
