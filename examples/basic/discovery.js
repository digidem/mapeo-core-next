import getPort from 'get-port'
import createTestnet from '@hyperswarm/testnet'

import { createCoreKeyPair, createIdentityKeys } from '../../tests/helpers/index.js'
import { Discovery } from '../../lib/discovery.js'

const testnet = await createTestnet(10)
const bootstrap = testnet.bootstrap

let key = process.argv[2]

const keyPair = createCoreKeyPair('mdns-peer-discovery')
const topic = key ? Buffer.from(key, 'hex') : keyPair.publicKey

const identity = createIdentityKeys()
const identityPublicKey = identity.identityKeyPair.publicKey.toString('hex')

const discover = new Discovery({
	topic,
	identityKeyPair: identity.identityKeyPair,
	port: await getPort(),
	mdns: false,
	// dht: { bootstrap }
})

console.log('identityPublicKey', identityPublicKey)

if (!key) {
	console.log('\ncopy and run this in a new terminal window:\n')
	console.log(`node examples/basic/discovery.js ${topic.toString('hex')}`)
}

discover.on('peer', (connection, peer, source) => {
	console.log('peer', peer, source)
	console.log('peers', discover.peers)
	console.log('own public key', identityPublicKey)
	console.log('topics', peer.topics)
})

await discover.join()
