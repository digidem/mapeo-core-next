import getPort from 'get-port'

import { createCoreKeyPair, createIdentityKeys } from '../../tests/helpers/index.js'
import { Discovery } from '../../lib/discovery.js'

let key = process.argv[2]

const keyPair = createCoreKeyPair('mdns-peer-discovery')
const topic = key ? Buffer.from(key, 'hex') : keyPair.publicKey

const identity = createIdentityKeys()
const identityPublicKey = identity.identityKeyPair.publicKey.toString('hex')

const discover = new Discovery({
	identityKeyPair: identity.identityKeyPair,
	port: await getPort(),
	mdns: false,
})

console.log('identityPublicKey', identityPublicKey)

if (!key) {
	console.log('\ncopy and run this in a new terminal window:\n')
	console.log(`node examples/basic/discovery.js ${topic.toString('hex')}`)
}

discover.on('peer', (connection, peer) => {
	// console.log('peer', peer)
	// console.log('peers', discover.peers)
	// console.log('own public key', identityPublicKey)
	// console.log('topics', peer.topics)
	// console.log('connection', connection)
	// console.log('peers', discover.dhtpeers)
})

await discover.join(topic)
