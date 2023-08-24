import test from 'brittle'
import { HyperswarmDiscovery } from '../src/discovery/hyperswarm.js'

test('discovery - dht/hyperswarm', async (t) => {
  // If I put this after the tests node complains
  // count is used before initialized...
  let count = 0
  async function step() {
    count++
    if (count === 1) {
      await swarm1.stop()
      await swarm2.stop()
    }
  }

  t.plan(1)
  const topic = 'myProjectDiscoveryId'
  const swarm1 = new HyperswarmDiscovery()
  const swarm2 = new HyperswarmDiscovery()

  swarm1.on('connection', (noiseStream, peerInfo) => {
    console.log('connected to!')
  })

  swarm2.on('connection', (noiseStream, peerInfo) => {
    console.log('connection from!')
    t.pass()
    step()
  })

  await swarm2.listen(topic)
  await swarm1.join(topic)
})

// import { createCoreKeyPair, createIdentityKeys } from './helpers/index.js'
// import { Discovery } from '../src/discovery/index.js'

// test('discovery - dht/hyperswarm', async (t) => {
//   t.plan(2)

//   const testnet = await createTestnet(10)
//   const bootstrap = testnet.bootstrap

//   const keyPair = createCoreKeyPair('dht-peer-discovery')

//   const identity1 = createIdentityKeys()
//   const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

//   const identity2 = createIdentityKeys()
//   const identityPublicKey2 = identity2.identityKeyPair.publicKey.toString('hex')

//   const discover1 = new Discovery({
//     identityKeyPair: identity1.identityKeyPair,
//     mdns: false,
//     dht: { bootstrap, server: true, client: true },
//   })

//   const discover2 = new Discovery({
//     identityKeyPair: identity2.identityKeyPair,
//     mdns: false,
//     dht: { bootstrap, server: true, client: true },
//   })

//   await discover1.ready()
//   await discover2.ready()

//   discover1.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey2, 'match key of 2nd peer')
//     await step()
//   })

//   discover2.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey1, 'match key of 1st peer')
//     await step()
//   })

//   let count = 0
//   async function step() {
//     count++
//     if (count === 2) {
//       await discover1.leave(keyPair.publicKey)
//       await discover2.leave(keyPair.publicKey)
//       await discover1.destroy()
//       await discover2.destroy()
//       await testnet.destroy()
//     }
//   }

//   await discover1.join(keyPair.publicKey)
//   await discover2.join(keyPair.publicKey)
// })

// test('replication - dht/hyperswarm', async (t) => {
//   const testnet = await createTestnet(10)
//   const bootstrap = testnet.bootstrap

//   const core1 = new Hypercore(ram)
//   await core1.ready()

//   const core2 = new Hypercore(ram, core1.key)
//   await core2.ready()

//   core1.append(['a', 'b', 'c'])

//   async function create({ dhtActive, mdnsActive, key }) {
//     const identity = createIdentityKeys()

//     const discovery = new Discovery({
//       identityKeyPair: identity.identityKeyPair,
//       dht: dhtActive && { bootstrap, server: true, client: true },
//       mdns: mdnsActive,
//     })

//     const core = new Hypercore(ram, key)
//     await core.ready()
//     await discovery.ready()

//     if (!key) {
//       await core.append(['a', 'b', 'c'])
//     }

//     return { discovery, identity, core, writer: !!key }
//   }

//   const readerCount = 5

//   const writer = await create({ dhtActive: true, mdnsActive: false })

//   const readers = await Promise.all(
//     Array(readerCount)
//       .fill(null)
//       .map(() => {
//         return create({ dhtActive: true, mdnsActive: false })
//       })
//   )

//   const instances = [writer, ...readers]
//   const connections = instances.length * (instances.length - 1)
//   t.plan(connections)

//   for (const instance of instances) {
//     instance.discovery.on('connection', async (connection, peer) => {
//       t.ok(peer)
//       instance.core.replicate(connection)
//       if (instance.writer) {
//         await step()
//       } else {
//         const stream = instance.core.createReadStream()

//         const results = []
//         stream.on('data', async (/** @type {any} */ data) => {
//           results.push(data)
//           if (results.length === 3) {
//             await step()
//           }
//         })
//       }
//     })
//   }

//   let count = 0
//   async function step() {
//     count++
//     if (count === connections) {
//       await Promise.all(
//         instances.map(async (instance) => {
//           await instance.discovery.leave(core1.discoveryKey)
//           await instance.discovery.destroy()
//         })
//       )
//       await testnet.destroy()
//     }
//   }

//   for (const instance of instances) {
//     await instance.discovery.join(core1.discoveryKey)
//   }
// })

// test('discovery - mdns', async (t) => {
//   t.plan(2)

//   const keyPair = createCoreKeyPair('mdns-peer-discovery')

//   const identity1 = createIdentityKeys()
//   const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

//   const identity2 = createIdentityKeys()
//   const identityPublicKey2 = identity2.identityKeyPair.publicKey.toString('hex')

//   const discover1 = new Discovery({
//     identityKeyPair: identity1.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })

//   const discover2 = new Discovery({
//     identityKeyPair: identity2.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })

//   await discover1.ready()
//   await discover2.ready()

//   discover1.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey2, 'match key of 2nd peer')
//     await step()
//   })

//   discover2.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey1, 'match key of 1st peer')
//     await step()
//   })

//   let count = 0
//   async function step() {
//     count++
//     if (count === 2) {
//       await discover1.leave(keyPair.publicKey)
//       await discover2.leave(keyPair.publicKey)
//       await discover1.destroy()
//       await discover2.destroy()
//     }
//   }

//   await discover1.join(keyPair.publicKey)
//   await discover2.join(keyPair.publicKey)
// })

// test('replication - mdns', async (t) => {
//   t.plan(3)

//   const core1 = new Hypercore(ram)
//   await core1.ready()

//   const core2 = new Hypercore(ram, core1.key)
//   await core2.ready()

//   core1.append(['a', 'b', 'c'])

//   const identity1 = createIdentityKeys()
//   const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

//   const identity2 = createIdentityKeys()
//   const identityPublicKey2 = identity2.identityKeyPair.publicKey.toString('hex')

//   const discover1 = new Discovery({
//     identityKeyPair: identity1.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })

//   const discover2 = new Discovery({
//     identityKeyPair: identity2.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })

//   await discover1.ready()
//   await discover2.ready()

//   discover1.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey2, 'match key of 2nd peer')
//     core1.replicate(connection)
//     await step()
//   })

//   discover2.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey1, 'match key of 1st peer')
//     core2.replicate(connection)

//     const stream = core2.createReadStream({ live: true })

//     const results = []
//     stream.on('data', async (/** @type {any} */ data) => {
//       results.push(data)
//       if (results.length === 3) {
//         t.pass()
//         await step()
//       }
//     })
//   })

//   let count = 0
//   async function step() {
//     count++
//     if (count === 2) {
//       await discover1.leave(core1.discoveryKey)
//       await discover2.leave(core1.discoveryKey)
//       await discover1.destroy()
//       await discover2.destroy()
//     }
//   }

//   await discover1.join(core1.discoveryKey)
//   await discover2.join(core1.discoveryKey)
// })

// test('discovery - multiple successive joins', async (t) => {
//   t.plan(4)

//   const testnet = await createTestnet(10)
//   const bootstrap = testnet.bootstrap

//   const keyPair = createCoreKeyPair('multiple successive joins')
//   const identity1 = createIdentityKeys()

//   const discover1 = new Discovery({
//     identityKeyPair: identity1.identityKeyPair,
//     mdns: true,
//     dht: { bootstrap, server: true, client: true },
//   })

//   await discover1.ready()

//   await discover1.join(keyPair.publicKey)
//   t.ok(discover1.topics.length === 1)
//   await discover1.join(keyPair.publicKey)

//   t.ok(discover1.topics.length === 1)
//   await discover1.join(keyPair.publicKey)

//   t.ok(discover1.topics.length === 1)

//   await discover1.leave(keyPair.publicKey)
//   await discover1.destroy()
//   t.ok(discover1.topics.length === 0)
//   await testnet.destroy()
// })

// test('discovery - mdns join, leave, join', async (t) => {
//   t.plan(5)

//   const keyPair = createCoreKeyPair('join, leave, join')
//   const identity1 = createIdentityKeys()
//   const identityPublicKey1 = identity1.identityKeyPair.publicKey.toString('hex')

//   const identity2 = createIdentityKeys()

//   const discover1 = new Discovery({
//     identityKeyPair: identity1.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })
//   const discover2 = new Discovery({
//     identityKeyPair: identity2.identityKeyPair,
//     mdns: true,
//     dht: false,
//   })

//   await discover1.ready()
//   await discover2.ready()

//   discover2.on('connection', async (connection, peer) => {
//     t.ok(peer.identityPublicKey === identityPublicKey1, 'match key of 1st peer')
//     t.ok(discover2.peers.length === 1, 'expected peers count')

//     await discover1.leave(keyPair.publicKey)
//     t.ok(discover1.topics.length === 0, 'no topics')

//     await discover1.join(keyPair.publicKey, { dht: false })
//     t.ok(discover1.topics.length === 1, 'expected topic object')

//     await discover1.leave(keyPair.publicKey)
//     await discover2.leave(keyPair.publicKey)
//     await discover1.destroy()
//     await discover2.destroy()
//   })

//   await discover1.join(keyPair.publicKey, { dht: false })
//   t.ok(discover1.topics.length === 1, 'expected topic object')
//   await discover2.join(keyPair.publicKey, { dht: false })
// })

// // Create a stress test with many peers to see if the connections made using the proper discovery mechanisms
// // i.e. mdns peers will only connect with mdns-enabled peers and dht peers will only connect with dht-enabled peers
// test('discovery - valid connection discovery types', async (t) => {
//   t.timeout(35000)

//   const testnet = await createTestnet(10)
//   const bootstrap = testnet.bootstrap

//   const keyPair = createCoreKeyPair('stress test')

//   function create({ dhtActive, mdnsActive }) {
//     const identity = createIdentityKeys()

//     return new Discovery({
//       identityKeyPair: identity.identityKeyPair,
//       dht: dhtActive && { bootstrap, server: true, client: true },
//       mdns: mdnsActive,
//     })
//   }

//   const each = 5 // much higher than this and it hits the timeout
//   const total = each * 3
//   const mdnsCount = ((total * (total - each - 1)) / total) * each
//   const dhtCount = ((total * (total - each - 1)) / total) * each
//   const mdnsAndDhtCount = ((total * (total - 1)) / total) * each
//   const connections = mdnsCount + dhtCount + mdnsAndDhtCount

//   t.plan(connections)

//   const mdnsOnly = Array(each)
//     .fill(null)
//     .map(() => {
//       return create({ dhtActive: false, mdnsActive: true })
//     })

//   const dhtOnly = Array(each)
//     .fill(null)
//     .map(() => {
//       return create({ dhtActive: true, mdnsActive: false })
//     })

//   const mdnsAndDht = Array(each)
//     .fill(null)
//     .map(() => {
//       return create({ dhtActive: true, mdnsActive: true })
//     })

//   const instances = [...mdnsOnly, ...dhtOnly, ...mdnsAndDht]

//   await Promise.all(instances.map((instance) => instance.ready()))

//   for (const instance of instances) {
//     /** @type {string[]} */
//     const allowedDiscoveryTypes = []

//     if (instance.dhtActive) {
//       allowedDiscoveryTypes.push('dht')
//     }

//     if (instance.mdnsActive) {
//       allowedDiscoveryTypes.push('mdns')
//     }

//     instance.on('connection', async (_, peer) => {
//       if (!allowedDiscoveryTypes.includes(peer.discoveryType)) {
//         t.fail()
//         return
//       }

//       t.ok(peer)
//       await step()
//     })
//   }

//   let count = 0
//   async function step() {
//     count++
//     if (count === connections) {
//       await Promise.all(
//         instances.map(async (instance) => {
//           await instance.leave(keyPair.publicKey)
//           await instance.destroy()
//         })
//       )
//       await testnet.destroy()
//     }
//   }

//   for (const instance of instances) {
//     await instance.join(keyPair.publicKey)
//   }
// })
