import test from 'node:test'
import assert from 'node:assert/strict'

test('migrations pick up values that were previously not understood', async () => {
  // TODO(evanhahn) Write this test
  // Receive an observation with a new field, `foo`
  // Get the bytes, add it to the core, see that it's in SQLite without a `foo` column
  // Do a migration where `foo` is added
  // Reload the project and see that `foo` is now there
})
