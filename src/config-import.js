import yauzl from 'yauzl-promise'
import { validate, valueSchemas } from '@mapeo/schema'
import { json, buffer } from 'node:stream/consumers'
import path from 'node:path'

// Throw error if a zipfile contains more than 10,000 entries
const MAX_ENTRIES = 10_000

/**
 * @typedef {yauzl.Entry} Entry
 * `@types/yauzl-promise` has the wrong name for this key. We should
 * eventually submit this patch upstream.
 */
/**
 * @typedef {{
 *   presets: { [id: string]: unknown }
 *   fields:  { [id: string]: unknown }
 * }} PresetsFile
 */
/**
 * @typedef {Parameters<import('./icon-api.js').IconApi['create']>[0]} IconData
 */

/**
 * @param {string} configPath
 */
export async function readConfig(configPath) {
  /** @type {Error[]} */
  const warnings = []
  /** @type {yauzl.ZipFile} */
  let iconsZip

  const presetsZip = await yauzl.open(configPath)
  if (presetsZip.entryCount > MAX_ENTRIES) {
    throw new Error(`Zip file contains too many entries. Max is ${MAX_ENTRIES}`)
  }
  /** @type {undefined | Entry} */
  let presetsEntry
  for await (const entry of presetsZip) {
    if (entry.filename === 'presets.json') {
      presetsEntry = entry
      break
    }
  }
  if (!presetsEntry) {
    throw new Error('Zip file does not contain presets.json')
  }
  const presetsFile = await json(await presetsEntry.openReadStream())
  validatePresetsFile(presetsFile)

  return {
    get warnings() {
      if (warnings.length === 0) return []
      return warnings
    },

    async close() {
      presetsZip.close()
      iconsZip.close()
    },

    /**
     * @returns {AsyncIterable<IconData>}
     */
    async *icons() {
      /** @type {IconData | undefined} */
      let icon

      iconsZip = await yauzl.open(configPath)
      const entries = await iconsZip.readEntries(MAX_ENTRIES)
      for (const entry of entries) {
        if (!entry.filename.match(/^icons\/([^/]+)$/)) continue
        const buf = await buffer(await entry.openReadStream())
        const iconFilename = entry.filename.replace(/^icons\//, '')
        try {
          const { name, variant } = parseIcon(iconFilename, buf)
          if (!icon) {
            icon = {
              name,
              variants: [variant],
            }
          } else if (icon.name === name) {
            icon.variants.push(variant)
          } else {
            yield icon
            icon = {
              name,
              variants: [variant],
            }
          }
        } catch (err) {
          warnings.push(err)
        }
      }
      if (icon) {
        yield icon
      }
    },

    /**
     * @returns {Iterable<{ name: string, value: import('@mapeo/schema').FieldValue }>}
     */
    *fields() {
      const { fields } = presetsFile
      for (const [name, field] of Object.entries(fields)) {
        if (!isRecord(field) && !hasOwn(field, 'key')) {
          warnings.push(new Error(`Invalid field ${name}`))
          continue
        }
        /** @type {Record<string, unknown>} */
        const fieldValue = {
          schemaName: 'field',
          tagKey: field.key,
        }
        for (const key of Object.keys(valueSchemas.field.properties)) {
          if (hasOwn(field, key)) {
            // @ts-ignore - we validate below
            fieldValue[key] = field[key]
          }
        }
        if (!validate('field', fieldValue)) {
          warnings.push(new Error(`Invalid field ${name}`))
          continue
        }
        yield {
          name,
          value: fieldValue,
        }
      }
    },

    /**
     * @returns {Iterable<{ fieldNames: string[], iconName: string | undefined, value: import('@mapeo/schema').PresetValue }>}
     */
    *presets() {
      const { presets } = presetsFile
      // sort presets using the sort field, turn them into an array
      const sortedPresets = Object.keys(presets)
        .filter((presetName) => {
          /** @type {any} */
          const preset = presets[presetName]
          const isInvalidPreset = !isRecord(preset)
          if (isInvalidPreset) {
            warnings.push(new Error(`invalid preset ${presetName}`))
          }
          return !isInvalidPreset
        })
        .map((presetName) => {
          /** @type {any} */
          const preset = presets[presetName]
          if (!preset.sort) {
            // if there's no sort field, put a big value - puts the field at the end -
            preset.sort = 100
          }
          return preset
        })
        .sort((preset, nextPreset) => nextPreset.sort - preset.sort)

      // 5. for each preset get the corresponding fieldId and iconId, add them to the db
      for (let preset of sortedPresets) {
        /** @type {any} */
        const presetValue = {
          schemaName: 'preset',
          fieldIds: [],
          addTags: {},
          removeTags: {},
          terms: [],
        }
        for (const key of Object.keys(valueSchemas.preset.properties)) {
          if (key in preset) {
            // @ts-ignore - we validate below
            presetValue[key] = preset[key]
          }
        }
        if (!validate('preset', presetValue)) {
          warnings.push(new Error(`Invalid preset ${preset.name}`))
          continue
        }
        yield {
          fieldNames:
            'fields' in preset && Array.isArray(preset.fields)
              ? preset.fields
              : [],
          iconName:
            'icon' in preset && typeof preset.icon === 'string'
              ? preset.icon
              : undefined,
          value: presetValue,
        }
      }
    },
  }
}

/**
 * @param {string} filename
 * @param {Buffer} buf
 * @returns {{ name: string, variant: IconData['variants'][Number] }}}
 */
function parseIcon(filename, buf) {
  const parsedFilename = path.parse(filename)
  const matches = parsedFilename.base.match(
    /([a-zA-Z0-9-]+)-([a-zA-Z]+)@(\d+)x\.(png|svg)$/
  )
  if (!matches) {
    throw new Error(`Unexpected icon filename ${filename}`)
  }
  /* eslint-disable no-unused-vars */
  const [_, name, size, pixelDensityStr] = matches
  const pixelDensity = Number(pixelDensityStr)
  if (!(pixelDensity === 1 || pixelDensity === 2 || pixelDensity === 3)) {
    throw new Error(`Error loading icon. invalid pixel density ${pixelDensity}`)
  }
  if (!(size === 'small' || size === 'medium' || size === 'large')) {
    throw new Error(`Error loading icon. invalid size ${size}`)
  }
  if (!name) {
    throw new Error('Error loading icon. missing name')
  }
  /** @type {'image/png' | 'image/svg+xml'} */
  let mimeType
  switch (parsedFilename.ext.toLowerCase()) {
    case '.png':
      mimeType = 'image/png'
      break
    case '.svg':
      mimeType = 'image/svg+xml'
      break
    default:
      throw new Error(`Unexpected icon extension ${parsedFilename.ext}`)
  }
  return {
    name,
    variant: {
      size,
      mimeType,
      pixelDensity,
      blob: buf,
    },
  }
}

/**
 * @param {unknown} presetsFile
 * @returns {asserts presetsFile is PresetsFile}
 */
function validatePresetsFile(presetsFile) {
  if (
    !isRecord(presetsFile) ||
    !isRecord(presetsFile.presets) ||
    !isRecord(presetsFile.fields)
  ) {
    throw new Error('Invalid presets.json file')
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {Record<string | symbol, unknown>} obj
 * @param {string | symbol} prop
 */
function hasOwn(obj, prop) {
  if (!isRecord(obj)) return
  return Object.prototype.hasOwnProperty.call(obj, prop)
}
