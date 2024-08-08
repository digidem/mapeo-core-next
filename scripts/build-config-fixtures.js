import yazl from 'yazl'
import * as fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, relative } from 'node:path'

const CONFIG_FIXTURES_PATH = new URL(
  '../tests/fixtures/config',
  import.meta.url
).pathname
const dir = await fs.readdir(CONFIG_FIXTURES_PATH, { withFileTypes: true })
console.log('zipping config fixtures')
for (const fileOrFolder of dir) {
  const p = join(CONFIG_FIXTURES_PATH, fileOrFolder.name)
  if (fileOrFolder.isDirectory()) {
    zipFolder(p)
  }
}

/**
 * @param {String} path
 */
async function zipFolder(path) {
  const zip = new yazl.ZipFile()
  const zipPath = `${path}.zip`
  const wstream = createWriteStream(zipPath)
  zip.outputStream.pipe(wstream).on('close', function () {
    console.log(`done zipping ${zipPath.split('/').at(-1)}`)
  })
  const contents = await fs.readdir(path, { withFileTypes: true })
  for (const content of contents) {
    const filePath = join(path, content.name)
    for await (const p of walk(filePath, content.isDirectory())) {
      const zipPath = relative(path, p)
      zip.addFile(p, zipPath)
    }
  }
  zip.end()
}

/**
 * @param {string} path
 * @param {boolean} isDirectory
 * @returns {AsyncGenerator<string>}
 */
async function* walk(path, isDirectory) {
  if (isDirectory) {
    const dir = await fs.readdir(path, { withFileTypes: true })
    for (const newPath of dir) {
      yield* walk(join(path, newPath.name), newPath.isDirectory())
    }
  } else {
    yield path
  }
}
