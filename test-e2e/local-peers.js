// @ts-check
import { test } from 'brittle'
import {
  connectPeers,
  createManagers,
  disconnectPeers,
  waitForPeers,
} from './utils.js'

test('Local peers discovery each other and share device info', async (t) => {
  const mobileManagers = await createManagers(5, t, 'mobile')
  const desktopManagers = await createManagers(5, t, 'desktop')
  const managers = [...mobileManagers, ...desktopManagers]
  connectPeers(managers, { discovery: true })
  t.teardown(() => disconnectPeers(managers))
  await waitForPeers(managers, { waitForDeviceInfo: true })
  const deviceInfos = [...mobileManagers, ...desktopManagers].map((m) =>
    m.getDeviceInfo()
  )
  const mPeers = await Promise.all(managers.map((m) => m.listLocalPeers()))
  for (const [i, peers] of mPeers.entries()) {
    const expectedDeviceInfos = removeElementAt(deviceInfos, i)
    const actualDeviceInfos = peers.map((p) => ({
      name: p.name,
      deviceId: p.deviceId,
      deviceType: p.deviceType,
    }))
    t.alike(
      new Set(actualDeviceInfos),
      new Set(expectedDeviceInfos),
      `manager ${i} has correct peers`
    )
  }
})

/**
 * @template T
 * @param {ReadonlyArray<T>} array
 * @param {number} i
 * @returns {Array<T>}
 */
function removeElementAt(array, i) {
  return array.slice(0, i).concat(array.slice(i + 1))
}
