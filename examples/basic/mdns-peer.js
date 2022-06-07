import { createCoreKeyPair, createIdentityKeys } from '../../tests/helpers/index.js'

import { MdnsPeerDiscovery } from '../../lib/localpeers.js'

let key = process.argv[2]

const keyPair = createCoreKeyPair('mdns-peer-discovery')
const topic = key ? key : keyPair.publicKey.toString('hex')

const identity = createIdentityKeys()
const identityPublicKey = identity.identityKeyPair.publicKey.toString('hex')

const discover = new MdnsPeerDiscovery({
	name: 'mapeo',
	topic,
	identityKeyPair: identity.identityKeyPair,
	port: key ? 8764 : 8765,
})

console.log('identityPublicKey', identityPublicKey)

if (!key) {
	console.log('\ncopy and run this in a new terminal window:\n')
	console.log(`node examples/basic/mdns-peer.js ${topic}`)
}

discover.on('connection', (connection, peer, source) => {
	console.log('peer', peer, source)
	console.log('peers', discover.peers)
	console.log('peers.length', discover.peers.length)
	console.log('own public key', identityPublicKey)
})
