import test from 'node:test'
import assert from 'node:assert/strict'
import { arrayFrom, size } from 'iterpal'
import { defaultConfigPath } from './helpers/default-config.js'
import { readConfig } from '../src/config-import.js'

test('config import - loading', async () => {
  await assert.rejects(
    async () => await readConfig(''),
    /ENOENT/,
    'file not found'
  )

  await assert.rejects(
    async () => await readConfig('./tests/fixtures/config/notAZip.txt'),
    /End of Central Directory Record not found/,
    'not a zip file'
  )

  await assert.rejects(
    async () => await readConfig('./tests/fixtures/config/tooBigOfAZip.zip'),
    /Error: Zip file contains too many entries. Max is 10000/,
    'number of files in zip is above MAX_ENTRIES'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/configWithoutPresets.zip'),
    /Error: Zip file does not contain presets.json/,
    'missing presets.json'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidPresetsJSON.zip'),
    /Error: Could not parse presets.json/,
    'JSON.parse error of presets.json'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidPresetsFile.zip'),
    /Error: Invalid presets.json file/,
    'presets.json is not an object'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/missingPresetsField.zip'),
    /Error: Invalid presets.json file/,
    'no presets field in presets.json'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/presetsFieldNotAnObject.zip'),
    /Error: Invalid presets.json file/,
    'presets field in presets.json is not an object'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/missingFieldsField.zip'),
    /Error: Invalid presets.json file/,
    'no fields field in presets.json'
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/fieldsFieldNotAnObject.zip'),
    /Error: Invalid presets.json file/,
    'fields field in presets.json is not an object'
  )

  await assert.rejects(
    async () => await readConfig('./tests/fixtures/config/missingMetadata.zip'),
    /Zip file does not contain metadata.json/,
    ''
  )

  await assert.rejects(
    async () => await readConfig('./tests/fixtures/config/invalidMetadata.zip'),
    /Could not parse metadata.json/,
    ''
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidMetadataKey.zip'),
    /Error: Invalid structure of metadata file/,
    ''
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidMetadataKey2.zip'),
    /Error: Invalid structure of metadata file/,
    ''
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidMetadataValue.zip'),
    /Error: Invalid structure of metadata file/,
    ''
  )

  await assert.rejects(
    async () =>
      await readConfig('./tests/fixtures/config/invalidMetadataValue2.zip'),
    /Error: Invalid structure of metadata file/,
    ''
  )

  assert(
    await readConfig('./tests/fixtures/config/validConfig.zip'),
    'valid zip'
  )
})

test('config import - icons', async () => {
  // filename
  let config = await readConfig(
    './tests/fixtures/config/invalidIconFilename.zip'
  )
  await arrayFrom(config.icons())
  assert.equal(
    config.warnings.length,
    1,
    'we got one error when reading icon with wrong filename'
  )
  assert(
    /Unexpected icon filename/.test(config.warnings[0].message),
    'the error message is about badly formed icon name'
  )

  // pixel density
  config = await readConfig(
    './tests/fixtures/config/invalidIconPixelDensity.zip'
  )

  await arrayFrom(config.icons())

  assert.equal(
    config.warnings.length,
    1,
    'we got one error when reading icon with wrong pixel density'
  )
  assert(
    /invalid pixel density/.test(config.warnings[0].message),
    'the error message is about invalid pixel density'
  )

  // size
  config = await readConfig('./tests/fixtures/config/invalidIconSize.zip')

  await arrayFrom(config.icons())
  assert.equal(
    config.warnings.length,
    1,
    'we got one error when reading icon with wrong size'
  )
  assert(
    /invalid size/.test(config.warnings[0].message),
    'the error message is about invalid size'
  )

  config = await readConfig('./tests/fixtures/config/validIcons.zip')
  const icons = await arrayFrom(config.icons())
  assert.equal(icons.length, 2)
  for (const icon of icons) {
    if (icon.name === 'plant') {
      assert.equal(icon.variants.length, 3, '3 variants of plant icons')
    } else if (icon.name === 'tree') {
      assert.equal(icon.variants.length, 9, '9 - all - variants of tree icons')
    }
    for (const variant of icon.variants) {
      assert.equal(variant.mimeType, 'image/png', 'variant is a png')
    }
  }
  assert.equal(config.warnings.length, 0, 'no warnings on the file')
})

test('config import - fields', async () => {
  let config = await readConfig('./tests/fixtures/config/invalidField.zip')
  arrayFrom(config.fields())
  assert.equal(config.warnings.length, 3, 'we got 3 errors when reading fields')
  assert(
    /Invalid field noKeyField/.test(config.warnings[0].message),
    'the first error is because the field has no "key" field'
  )
  assert(
    /Invalid field nullField/.test(config.warnings[1].message),
    'the second error is because the field is null'
  )
  assert(
    /Invalid field noObjectField/.test(config.warnings[2].message),
    'the third error is because the field is not an object'
  )

  config = await readConfig('./tests/fixtures/config/validField.zip')
  for (const field of config.fields()) {
    assert.equal(field.name, 'nombre-monitor', `field.name is 'nombre-monitor'`)
    assert.equal(
      field.value.tagKey,
      'nombre-monitor',
      `tagKey of field is 'nombre-monitor'`
    )
    assert.equal(field.value.schemaName, 'field', `schemaName is 'field'`)
  }
  assert.equal(config.warnings.length, 0, 'no warnings on the file')
})

test('config import - presets', async () => {
  let config = await readConfig('./tests/fixtures/config/invalidPreset.zip')
  arrayFrom(config.presets())
  assert.equal(
    config.warnings.length,
    2,
    'we got two errors when reading presets'
  )
  assert(
    /invalid preset noObjectPreset/.test(config.warnings[0].message),
    'the first error is because the preseassert.equal not an object'
  )
  assert(
    /invalid preset nullPreset/.test(config.warnings[1].message),
    'the second error is because the preset is null'
  )

  config = await readConfig('./tests/fixtures/config/validPreset.zip')
  for (const preset of config.presets()) {
    assert.equal(preset.value.schemaName, 'preset', `schemaName is 'preset'`)
    assert(
      preset.value.name === 'Planta' ||
        preset.value.name === 'Punto de entrada',
      'the preset name is expected'
    )
  }
  assert.equal(config.warnings.length, 0, `no warnings on the file`)
})

test('config import - translations', async () => {
  const config = await readConfig(defaultConfigPath)
  for (const { value } of config.translations()) {
    assert.equal(value.schemaName, 'translation', `schemaName is 'translation'`)

    assert(
      value.docRefType === 'preset' || value.docRefType === 'field',
      `Config translates only 'fields' or 'presets'`
    )
  }
  assert.equal(
    config.warnings.length,
    0,
    `no warnings when loading the default config`
  )
})

test('config import - load default config', async () => {
  const config = await readConfig(defaultConfigPath)
  assert(config, 'valid config file')

  assert.equal(
    size(config.fields()),
    11,
    'correct number of fields in default config'
  )
  let nIcons = 0
  let nVariants = 0
  /* eslint-disable-next-line */
  for await (const icon of config.icons()) {
    nIcons++
    nVariants += size(icon.variants)
  }
  assert.equal(nIcons, 26, 'correct number of icons in default config')
  assert.equal(
    nVariants,
    234,
    'correct number of icon variants in default config'
  )

  assert.equal(
    size(config.presets()),
    28,
    'correct number of presets in default config'
  )

  assert.equal(
    size(config.translations()),
    870,
    'correct number of translations in default config'
  )

  assert.equal(config.warnings.length, 0, 'no warnings on config file')
})
