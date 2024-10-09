import { isIPv4, isIPv6 } from 'node:net'

/**
 * Is this hostname an IP address?
 *
 * @param {string} hostname
 * @returns {boolean}
 * @example
 * isHostnameIpAddress('100.64.0.42')
 * // => false
 *
 * isHostnameIpAddress('[2001:0db8:85a3:0000:0000:8a2e:0370:7334]')
 * // => true
 *
 * isHostnameIpAddress('example.com')
 * // => false
 */
export function isHostnameIpAddress(hostname) {
  if (isIPv4(hostname)) return true

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return isIPv6(hostname.slice(1, -1))
  }

  return false
}
