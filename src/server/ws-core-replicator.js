import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createWebSocketStream } from 'ws'

/**
 * @param {import('ws').WebSocket} ws
 * @param {import('../types.js').ReplicationStream} replicationStream
 */
export function wsCoreReplicator(ws, replicationStream) {
  // This is purely to satisfy typescript at its worst. `pipeline` expects a
  // NodeJS ReadWriteStream, but our replicationStream is a streamx Duplex
  // stream. The difference is that streamx does not implement the
  // `setEncoding`, `unpipe`, `wrap` or `isPaused` methods. The `pipeline`
  // function does not depend on any of these methods (I have read through the
  // NodeJS source code at cebf21d (v22.9.0) to confirm this), so we can safely
  // cast the stream to a NodeJS ReadWriteStream.
  const _replicationStream = /** @type {NodeJS.ReadWriteStream} */ (
    /** @type {unknown} */ (replicationStream)
  )
  return pipeline(
    _replicationStream,
    wsSafetyTransform(ws),
    createWebSocketStream(ws),
    _replicationStream
  )
}

/**
 * Avoid writing data to a closing or closed websocket, which would result in an
 * error. Instead we drop the data and wait for the stream close/end events to
 * propagate and close the streams cleanly.
 *
 * @param {import('ws').WebSocket} ws
 */
function wsSafetyTransform(ws) {
  return new Transform({
    transform(chunk, encoding, callback) {
      if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
        return callback()
      }
      callback(null, chunk)
    },
  })
}
