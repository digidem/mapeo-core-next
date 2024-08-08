import yauzl from 'yauzl-promise'
import { validate, valueSchemas } from '@mapeo/schema'
import { json, buffer } from 'node:stream/consumers'
import { assert } from './utils.js'
import path from 'node:path'
import { parse as parseBCP47 } from 'bcp-47'
import { SUPPORTED_CONFIG_VERSION } from './constants.js'

// Throw error if a zipfile contains more than 10,000 entries
const MAX_ENTRIES = 10_000
const MAX_ICON_SIZE = 10_000_000

/**
 * @typedef {yauzl.Entry} Entry
 */
/**
 * @typedef {{
 *   presets: { [id: string]: unknown }
 *   fields:  { [id: string]: unknown }
 * }} PresetsFile
 */

/** @typedef {('presets' | 'fields')} ValidDocTypes */
/**
 * @typedef {{
 *  [lang: string]: unknown
 * }} TranslationsFile
 */

/** @typedef {NonNullable<import('@mapeo/schema').ProjectSettingsValue['configMetadata']>} MetadataFile */

/**
 * @typedef {Parameters<import('./icon-api.js').IconApi['create']>[0]} IconData
 */

/**
 * @param {string} configPath
 */
export async function readConfig(configPath) {
  /** @type {Error[]} */
  const warnings = []
  const importDate = new Date().toISOString()

  const zip = await yauzl.open(configPath)
  if (zip.entryCount > MAX_ENTRIES) {
    // MAX_ENTRIES in MAC can be inacurrate
    throw new Error(`Zip file contains too many entries. Max is ${MAX_ENTRIES}`)
  }
  const entries = await zip.readEntries(MAX_ENTRIES)
  const presetsFile = await findPresetsFile(entries)
  const translationsFile = await findTranslationsFile(entries)
  const metadataFile = await findMetadataFile(entries)
  assert(
    isValidConfigFile(metadataFile),
    `invalid or missing config file version ${metadataFile.fileVersion}. We support version ${SUPPORTED_CONFIG_VERSION}}`
  )

  return {
    get warnings() {
      return warnings
    },

    get metadata() {
      return { ...metadataFile, importDate }
    },

    async close() {
      zip.close()
    },

    /**
     * @returns {AsyncIterable<IconData>}
     */
    async *icons() {
      /** @type {IconData | undefined} */
      let icon

      // we sort the icons by filename so we can group variants together
      const iconEntries = entries
        .filter((entry) => entry.filename.match(/^icons\/([^/]+)$/))
        .sort((icon, nextIcon) =>
          icon.filename.localeCompare(nextIcon.filename)
        )

      for (const entry of iconEntries) {
        if (entry.uncompressedSize > MAX_ICON_SIZE) {
          warnings.push(
            new Error(
              `icon ${entry.filename} is bigger than maximum allowed size (10MB) `
            )
          )
          continue
        }
        const buf = await buffer(await entry.openReadStream())
        const iconFilename = entry.filename.replace(/^icons\//, '')
        try {
          const { name, variant } = parseIcon(iconFilename, buf)
          // new icon (first pass)
          if (!icon) {
            icon = {
              name,
              variants: [variant],
            }
            // icon already exists, push new variant
          } else if (icon.name === name) {
            icon.variants.push(variant)
          } else {
            // icon has change
            yield icon
            icon = {
              name,
              variants: [variant],
            }
          }
        } catch (err) {
          warnings.push(
            err instanceof Error
              ? err
              : new Error('Unknown error importing icon')
          )
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
        if (!isRecord(field)) {
          warnings.push(new Error(`Invalid field ${name}`))
          continue
        }
        /** @type {Record<string, unknown>} */
        const fieldValue = {
          schemaName: 'field',
        }
        for (const key of Object.keys(valueSchemas.field.properties)) {
          if (hasOwn(field, key)) {
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
     * @returns {Iterable<{ fieldNames: string[], iconName: string | undefined, value: import('@mapeo/schema').PresetValue, name: string}>}
     */
    *presets() {
      const { presets } = presetsFile
      // sort presets using the sort field, turn them into an array
      /** @type {Array<{preset:Record<string, unknown>, name: String}>} */
      const sortedPresets = []
      for (const [presetName, preset] of Object.entries(presets)) {
        if (isRecord(preset)) {
          sortedPresets.push({ name: presetName, preset })
        } else {
          warnings.push(new Error(`invalid preset ${presetName}`))
        }
      }
      sortedPresets.sort(({ preset }, { preset: nextPreset }) => {
        const sort = typeof preset.sort === 'number' ? preset.sort : Infinity
        const nextSort =
          typeof nextPreset.sort === 'number' ? nextPreset.sort : Infinity
        return sort - nextSort
      })

      // 5. for each preset get the corresponding fieldId and iconId, add them to the db
      for (const { preset, name } of sortedPresets) {
        /** @type {Record<string, unknown>} */
        const presetValue = {
          schemaName: 'preset',
          fieldRefs: [],
          addTags: {},
          removeTags: {},
          terms: [],
        }
        for (const key of Object.keys(valueSchemas.preset.properties)) {
          if (hasOwn(preset, key)) {
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
          name,
        }
      }
    },
    /** @returns {Iterable<{ name: string, value:Omit<import('@mapeo/schema').TranslationValue, 'docRef'>}>} */
    *translations() {
      if (!translationsFile) return
      for (const [lang, languageTranslations] of Object.entries(
        translationsFile
      )) {
        if (!isRecord(languageTranslations)) {
          throw new Error('invalid language translations object')
        }
        for (const { name, value } of translationsForLanguage(warnings)(
          lang,
          languageTranslations
        )) {
          yield { name, value }
        }
      }
    },
  }
}

/**
 * @param {ReadonlyArray<Entry>} entries
 * @rejects if the presets file cannot be found or is invalid
 * @returns {Promise<PresetsFile>}
 */
async function findPresetsFile(entries) {
  const presetsEntry = entries.find(
    (entry) => entry.filename === 'presets.json'
  )
  assert(presetsEntry, 'Zip file does not contain presets.json')

  /** @type {unknown} */
  let result
  try {
    result = await json(await presetsEntry.openReadStream())
  } catch (err) {
    throw new Error('Could not parse presets.json')
  }

  assert(isRecord(result), 'Invalid presets.json file')
  const { presets, fields } = result
  assert(isRecord(presets) && isRecord(fields), 'Invalid presets.json file')

  return { presets, fields }
}

/**
 * @param {ReadonlyArray<Entry>} entries
 * @returns {Promise<TranslationsFile | undefined>}
 */
async function findTranslationsFile(entries) {
  const translationEntry = entries.find(
    (entry) => entry.filename === 'translations.json'
  )
  if (!translationEntry) return

  /** @type {unknown} */
  let result
  try {
    result = await json(await translationEntry.openReadStream())
  } catch (err) {
    throw new Error('Could not parse translations.json')
  }
  assert(isRecord(result), 'Invalid translations.json file')
  return result
}

/**
 * @param {ReadonlyArray<Entry>} entries
 * @returns {Promise<Omit<MetadataFile, 'importDate'>>}
 */
async function findMetadataFile(entries) {
  const metadataEntry = entries.find(
    (entry) => entry.filename === 'metadata.json'
  )
  assert(metadataEntry, 'Zip file does not contain metadata.json')
  let result
  try {
    result = await json(await metadataEntry.openReadStream())
  } catch (err) {
    throw new Error('Could not parse metadata.json')
  }
  assert(isRecord(result), 'Invalid metadata.json file')
  assert(isValidMetadataFile(result), 'Invalid structure of metadata file')

  return result
}

/**
 * @param {Error[]} warnings
 */
function translationsForLanguage(warnings) {
  /**
   * @param {string} lang
   * @param {Record<string, unknown>} languageTranslations
   *
   */
  return function* (lang, languageTranslations) {
    const { language: languageCode, region: regionCode } = parseBCP47(lang)
    if (!languageCode) {
      warnings.push(new Error(`invalid translation language ${lang}`))
      return
    }
    for (const [
      schemaNamePlural,
      languageTranslationsForDocType,
    ] of Object.entries(languageTranslations)) {
      // TODO: remove categories check when removed from default config
      if (!(schemaNamePlural === 'fields' || schemaNamePlural === 'presets')) {
        if (schemaNamePlural !== 'categories') {
          warnings.push(new Error(`invalid docRef.type ${schemaNamePlural}`))
        }
        continue
      }
      if (!isRecord(languageTranslationsForDocType)) {
        warnings.push(new Error('invalid translation for docType object'))
        continue
      }
      yield* translationsForDocType(warnings)({
        languageCode,
        regionCode,
        docRefType: schemaNamePluralToDocRefType(schemaNamePlural),
        languageTranslationsForDocType,
      })
    }
  }
}
/**
 * schemaNames in configs are in plural but in the schemas are in singular
 * @param {ValidDocTypes} schemaNamePlural
 * @returns {import('@mapeo/schema').TranslationValue['docRefType']}
 */
function schemaNamePluralToDocRefType(schemaNamePlural) {
  if (schemaNamePlural === 'fields') return 'field'
  if (schemaNamePlural === 'presets') return 'preset'
  throw new Error(
    `invalid schemaNamePlural ${schemaNamePlural} for config import`
  )
}

/**
 * @param {Error[]} warnings
 */
function translationsForDocType(warnings) {
  /** @param {Object} opts
   * @param {string} opts.languageCode
   * @param {string | null | undefined} opts.regionCode
   * @param {import('@mapeo/schema').TranslationValue['docRefType']} opts.docRefType
   * @param {Record<ValidDocTypes, unknown>} opts.languageTranslationsForDocType
   */
  return function* ({
    languageCode,
    regionCode,
    docRefType,
    languageTranslationsForDocType,
  }) {
    for (const [docName, fieldsToTranslate] of Object.entries(
      languageTranslationsForDocType
    )) {
      if (!isRecord(fieldsToTranslate)) {
        warnings.push(new Error(`invalid translation field`))
        return
      }
      yield* translationForValue(warnings)({
        languageCode,
        regionCode,
        docRefType,
        docName,
        fieldsToTranslate,
      })
    }
  }
}

/**
 * @param {Error[]} warnings
 */
function translationForValue(warnings) {
  /**
   * @param {Object} opts
   * @param {string} opts.languageCode
   * @param {string | null | undefined} opts.regionCode
   * @param {import('@mapeo/schema').TranslationValue['docRefType']} opts.docRefType
   * @param {string} opts.docName
   * @param {Record<string,unknown>} opts.fieldsToTranslate
   */
  return function* ({
    languageCode,
    regionCode,
    docRefType,
    docName,
    fieldsToTranslate,
  }) {
    for (const [propertyRef, message] of Object.entries(fieldsToTranslate)) {
      let value = {
        /** @type {'translation'} */
        schemaName: 'translation',
        languageCode,
        regionCode: regionCode || '',
        docRefType,
        propertyRef: '',
        message: '',
      }

      if (isRecord(message) && isFieldOptions(message)) {
        yield* translateMessageObject(warnings)({ value, message, docName })
      } else if (typeof message === 'string') {
        value = { ...value, propertyRef, message }
        yield { name: docName, value }
      } else {
        warnings.push(
          new Error(`Invalid translation message type ${typeof message}`)
        )
        continue
      }
    }
  }
}

/**
 * @param {Error[]} warnings
 */
function translateMessageObject(warnings) {
  /**
   * @param {Object} opts
   * @param {Omit<import('@mapeo/schema').TranslationValue, 'docRef'>} opts.value
   * @param {string} opts.docName
   * @param {Record<string,{label:string,value:string}>} opts.message
   */
  return function* ({ value, message, docName }) {
    let idx = 0
    for (const translation of Object.values(message)) {
      if (isRecord(translation)) {
        for (const [key, msg] of Object.entries(translation)) {
          if (typeof msg === 'string') {
            value = {
              ...value,
              propertyRef: `${value.propertyRef}[${idx}].${key}`,
              message: msg,
            }
            if (
              !validate('translation', {
                ...value,
                docRef: { docId: '', versionId: '' },
              })
            ) {
              warnings.push(new Error(`Invalid translation ${value.message}`))
              continue
            }
            yield {
              value,
              name: docName,
            }
          }
        }
        idx++
      }
    }
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
    /([a-zA-Z0-9-]+)-([a-zA-Z]+)@(\d+)x\.[a-zA-Z]+$/
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
 * @param {Record<string,unknown>} obj
 * @returns {obj is Omit<MetadataFile, 'importDate'>}
 */
function isValidMetadataFile(obj) {
  // extra fields are valid
  return (
    'name' in obj &&
    'buildDate' in obj &&
    'fileVersion' in obj &&
    typeof obj['name'] === 'string' &&
    typeof obj['buildDate'] === 'string' &&
    typeof obj['fileVersion'] === 'string'
  )
}

/**
 * @param {Record<string, unknown>} message
 * @returns {message is Record<string,{label:string, value:string}>}
 */
function isFieldOptions(message) {
  return Object.values(message).every(
    (val) => isRecord(val) && 'label' in val && 'value' in val
  )
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
  return Object.prototype.hasOwnProperty.call(obj, prop)
}

/**
 * @param {Object} obj
 * @param {string | undefined} [obj.fileVersion]
 * @returns {boolean}
 */
function isValidConfigFile({ fileVersion }) {
  if (!fileVersion) return false
  const regex = /^(\d+)\.(\d+)$/
  const match = fileVersion.match(regex)

  if (!match) return false

  const major = parseInt(match[1], 10)
  //const minor = parseInt(match[2], 10)

  return major >= SUPPORTED_CONFIG_VERSION
}
