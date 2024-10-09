import assert from 'node:assert/strict'
import test from 'node:test'
import { isHostnameIpAddress } from '../../src/lib/is-hostname-ip-address.js'

test('IPv4', () => {
  const ips = ['0.0.0.0', '127.0.0.1', '100.64.0.42']
  for (const ip of ips) {
    assert(isHostnameIpAddress(ip))
  }
})

test('IPv6', () => {
  const ips = [
    '::',
    '2001:0db8:0000:0000:0000:0000:0000:0000',
    '0:0:0:0:0:ffff:6440:002a',
  ]
  for (const ip of ips) {
    assert(!isHostnameIpAddress(ip))
    assert(isHostnameIpAddress('[' + ip + ']'))
  }
})

test('non-IP addresses', () => {
  const hostnames = ['example', 'example.com', '123.example.com']
  for (const hostname of hostnames) {
    assert(!isHostnameIpAddress(hostname))
  }
})
