[API](../README.md) / [\<internal\>](../modules/internal_.md) / LiveDownload

# Class: LiveDownload

[\<internal\>](../modules/internal_.md).LiveDownload

LiveDownload class

## Hierarchy

- `TypedEmitter`

  ↳ **`LiveDownload`**

## Table of contents

### Constructors

- [constructor](internal_.LiveDownload.md#constructor)

### Accessors

- [state](internal_.LiveDownload.md#state)

## Constructors

### constructor

• **new LiveDownload**(`drives`, `emitter`, `options`): [`LiveDownload`](internal_.LiveDownload.md)

Like drive.download() but 'live', and for multiple drives

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `drives` | `Iterable`\<[`Hyperdrive`](internal_.Hyperdrive-1.md)\> |  |
| `emitter` | [`InternalDriveEmitter`](../modules/internal_.md#internaldriveemitter) |  |
| `options` | `Object` |  |
| `options.filter` | `undefined` \| [`BlobFilter`](../modules/internal_.md#blobfilter) | Filter blobs of specific types and/or sizes to download |
| `options.signal` | `undefined` \| `AbortSignal` |  |

#### Returns

[`LiveDownload`](internal_.LiveDownload.md)

#### Overrides

TypedEmitter.constructor

## Accessors

### state

• `get` **state**(): [`BlobDownloadState`](../interfaces/internal_.BlobDownloadState.md) \| [`BlobDownloadStateError`](../modules/internal_.md#blobdownloadstateerror)

#### Returns

[`BlobDownloadState`](../interfaces/internal_.BlobDownloadState.md) \| [`BlobDownloadStateError`](../modules/internal_.md#blobdownloadstateerror)
