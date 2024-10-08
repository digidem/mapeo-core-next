/** @import { PresetValue, IconValue } from '@comapeo/schema' */

export const kGetIconBlob = Symbol('getIcon')

/** @typedef {PresetValue['iconRef']} IconRef */
/** @typedef {IconValue['variants']} IconVariants */
/** @typedef {IconVariants[number]} IconVariant */

/**
 * @typedef {Exclude<IconVariant['size'], 'size_unspecified'>} ValidSizes
 */

/**
 * @typedef {Object} BitmapOpts
 * @property {Extract<IconVariant['mimeType'], 'image/png'>} mimeType
 * @property {Extract<IconVariant, {mimeType: 'image/png'}>['pixelDensity']} pixelDensity
 * @property {ValidSizes} size
 *
 * @typedef {Object} SvgOpts
 * @property {Extract<IconVariant['mimeType'], 'image/svg+xml'>} mimeType
 * @property {ValidSizes} size
 */

/** @type {{ [mime in IconVariant['mimeType']]: string }} */
const MIME_TO_EXTENSION = {
  'image/png': '.png',
  'image/svg+xml': '.svg',
}

export class IconApi {
  #dataType
  #dataStore
  #getMediaBaseUrl

  /**
   * @param {Object} opts
   * @param {import('./datatype/index.js').DataType<
   *   import('./datastore/index.js').DataStore<'config'>,
   *   typeof import('./schema/project.js').iconTable,
   *   'icon',
   *   import('@comapeo/schema').Icon,
   *   import('@comapeo/schema').IconValue
   * >} opts.iconDataType
   * @param {import('./datastore/index.js').DataStore<'config'>} opts.iconDataStore
   * @param {() => Promise<string>} opts.getMediaBaseUrl
   */
  constructor({ iconDataType, iconDataStore, getMediaBaseUrl }) {
    this.#dataType = iconDataType
    this.#dataStore = iconDataStore
    this.#getMediaBaseUrl = getMediaBaseUrl
  }

  /**
   * @param {object} icon
   * @param {import('@comapeo/schema').IconValue['name']} icon.name
   * @param {Array<(BitmapOpts | SvgOpts) & { blob: Buffer }>} icon.variants
   *
   * @returns {Promise<import('@comapeo/schema').Icon>}
   */
  async create(icon) {
    if (icon.variants.length < 1) {
      throw new Error('empty variants array')
    }

    const savedVariants = await Promise.all(
      icon.variants.map(async ({ blob, ...variant }) => {
        const blobVersionId = await this.#dataStore.writeRaw(blob)
        return { ...variant, blobVersionId }
      })
    )

    return await this.#dataType.create({
      schemaName: 'icon',
      name: icon.name,
      variants: savedVariants,
    })
  }

  /**
   * @param {string} iconId
   * @param {BitmapOpts | SvgOpts} opts
   *
   * @returns {Promise<Buffer>}
   */
  async [kGetIconBlob](iconId, opts) {
    const iconRecord = await this.#dataType.getByDocId(iconId)
    const iconVariant = getBestVariant(iconRecord.variants, opts)
    const blob = await this.#dataStore.readRaw(iconVariant.blobVersionId)
    return blob
  }

  /**
   * @param {string} iconId
   * @param {BitmapOpts | SvgOpts} opts
   *
   * @returns {Promise<string>}
   */
  async getIconUrl(iconId, opts) {
    let base = await this.#getMediaBaseUrl()

    if (!base.endsWith('/')) {
      base += '/'
    }

    const mimeExtension = MIME_TO_EXTENSION[opts.mimeType]

    const pixelDensity =
      opts.mimeType === 'image/svg+xml' ||
      // if the pixel density is 1, we can omit the density suffix in the resulting url
      // and assume the pixel density is 1 for applicable mime types when using the url
      opts.pixelDensity === 1
        ? undefined
        : opts.pixelDensity

    return (
      base +
      constructIconPath({
        pixelDensity,
        size: opts.size,
        extension: mimeExtension,
        iconId,
      })
    )
  }
}

/**
 * @type {Record<IconVariant['size'], number>}
 */
const SIZE_AS_NUMERIC = {
  // NOTE: when size is unspecified, we fallback to medium
  size_unspecified: 2,
  small: 1,
  medium: 2,
  large: 3,
}

/**
 * Given a list of icon variants returns the variant that most closely matches the desired parameters.
 * Rules, in order of precedence:
 *
 * 1. Matching mime type (throw if no matches)
 * 2. Matching size. If no exact match:
 *     1. If smaller ones exist, prefer closest smaller size.
 *     2. Otherwise prefer closest larger size.
 * 3. Matching pixel density (when asking for PNGs). If no exact match:
 *     1. If smaller ones exist, prefer closest smaller density.
 *     2. Otherwise prefer closest larger density.
 *
 * @param {IconVariants} variants
 * @param {BitmapOpts | SvgOpts} opts
 */
export function getBestVariant(variants, opts) {
  const { size: wantedSize, mimeType: wantedMimeType } = opts
  /** @type {BitmapOpts['pixelDensity']} */
  let wantedPixelDensity
  if (opts.mimeType === 'image/png') {
    wantedPixelDensity = opts.pixelDensity
  }
  if (variants.length === 0) {
    throw new Error('No variants exist')
  }

  const matchingMime = variants.filter((v) => v.mimeType === wantedMimeType)

  if (matchingMime.length === 0) {
    throw new Error(
      `No variants with desired mime type ${wantedMimeType} exist`
    )
  }
  const wantedSizeNum = SIZE_AS_NUMERIC[wantedSize]

  // Sort the relevant variants based on the desired size and pixel density, using the rules of the preference.
  // Sorted from closest match to furthest match.
  matchingMime.sort((a, b) => {
    const aSizeNum = SIZE_AS_NUMERIC[a.size]
    const bSizeNum = SIZE_AS_NUMERIC[b.size]

    const aSizeDiff = aSizeNum - wantedSizeNum
    const bSizeDiff = bSizeNum - wantedSizeNum

    // Both variants match desired size, use pixel density (when png) to determine preferred match
    if (aSizeDiff === 0 && bSizeDiff === 0) {
      // What to do if asking for an svg and both (a and b) are svgs and have the same size, what criteria do we use?
      // For now, we don't change sort order
      if (wantedMimeType === 'image/svg+xml') {
        return 0
      } else if (
        wantedMimeType === 'image/png' &&
        a.mimeType === 'image/png' &&
        b.mimeType === 'image/png'
      ) {
        return determineSortValue(
          wantedPixelDensity,
          a.pixelDensity,
          b.pixelDensity
        )
      }
    }

    return determineSortValue(wantedSizeNum, aSizeNum, bSizeNum)
  })

  // Closest match will be first element
  return matchingMime[0]
}

/**
 * Determines a sort value based on the order of precedence outlined below. Winning value moves closer to front.
 *
 * 1. Exactly match `target`
 * 2. Closest value smaller than `target`
 * 3. Closest value larger than `target`
 *
 * @param {number} target
 * @param {number} a
 * @param {number} b
 *
 * @returns {-1 | 0 | 1}
 */
function determineSortValue(target, a, b) {
  const aDiff = a - target
  const bDiff = b - target

  // Both match exactly, don't change sort order
  if (aDiff === 0 && bDiff === 0) {
    return 0
  }

  // a matches but b doesn't, prefer a
  if (aDiff === 0 && bDiff !== 0) {
    return -1
  }

  // b matches but a doesn't, prefer b
  if (bDiff === 0 && aDiff !== 0) {
    return 1
  }

  // Both are larger than desired, prefer smaller of the two
  if (aDiff > 0 && bDiff > 0) {
    return a < b ? -1 : 1
  }

  // Both are smaller than desired, prefer larger of the two
  if (aDiff < 0 && bDiff < 0) {
    return a < b ? 1 : -1
  }

  // Mix of smaller and larger than desired, prefer smaller of the two
  return a < b ? -1 : 1
}

/**
 * General purpose path builder for an icon
 *
 * @param {object} opts
 * @param {string} opts.iconId
 * @param {string} opts.size
 * @param {number} [opts.pixelDensity]
 * @param {string} opts.extension
 *
 * @returns {string}
 */
export function constructIconPath({ size, pixelDensity, iconId, extension }) {
  if (iconId.length === 0 || size.length === 0 || extension.length === 0) {
    throw new Error('iconId, size, and extension cannot be empty strings')
  }

  let result = `${iconId}/${size}`

  if (typeof pixelDensity === 'number') {
    if (pixelDensity < 1) {
      throw new Error('pixelDensity must be a positive number')
    }
    result += `@${pixelDensity}x`
  }

  result += extension.startsWith('.') ? extension : '.' + extension

  return result
}
