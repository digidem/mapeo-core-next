import test from 'node:test'
import assert from 'node:assert/strict'
import { createManager } from './utils.js'
import { defaultConfigPath } from '../tests/helpers/default-config.js'

test(' config import - load default config when passed a path to `createProject`', async (t) => {
  const manager = createManager('device0', t)
  const project = await manager.getProject(
    await manager.createProject({ configPath: defaultConfigPath })
  )
  const presets = await project.preset.getMany()
  const fields = await project.field.getMany()
  const translations = await project.$translation.dataType.getMany()
  assert.equal(presets.length, 28, 'correct number of loaded presets')
  assert.equal(fields.length, 11, 'correct number of loaded fields')
  assert.equal(
    translations.length,
    870,
    'correct number of loaded translations'
  )
})

test('config import - load and re-load config manually', async (t) => {
  const manager = createManager('device0', t)
  const project = await manager.getProject(await manager.createProject())

  const warnings = await project.importConfig({ configPath: defaultConfigPath })
  let presets = await project.preset.getMany()
  let fields = await project.field.getMany()
  let translations = await project.$translation.dataType.getMany()

  assert.equal(
    warnings.length,
    0,
    'no warnings when manually loading default config'
  )
  assert.equal(presets.length, 28, 'correct number of manually loaded presets')
  assert.equal(fields.length, 11, 'correct number of manually loaded fields')
  assert.equal(
    translations.length,
    870,
    'correct number of manually loaded translations'
  )

  // re load the config
  await project.importConfig({ configPath: defaultConfigPath })
  presets = await project.preset.getMany()
  fields = await project.field.getMany()
  translations = await project.$translation.dataType.getMany()
  assert.equal(
    presets.length,
    28,
    're-loading the same config leads to the same number of presets (since they are deleted)'
  )
  assert.equal(
    fields.length,
    11,
    're-loading the same config leads to the same number of fields (since they are deleted)'
  )
  assert.equal(
    translations.length,
    870,
    're-loading the same config leads to the same number of translations (since they are deleted)'
  )
})

test('failing on loading multiple configs in parallel', async (t) => {
  const manager = createManager('device0', t)
  const project = await manager.getProject(await manager.createProject())
  const results = await Promise.allSettled([
    project.importConfig({ configPath: defaultConfigPath }),
    project.importConfig({ configPath: defaultConfigPath }),
  ])
  assert.equal(results[0]?.status, 'fulfilled', 'first import should work')
  assert.equal(results[1]?.status, 'rejected', 'second import should fail')
})
