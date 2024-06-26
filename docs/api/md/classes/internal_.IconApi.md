[API](../README.md) / [\<internal\>](../modules/internal_.md) / IconApi

# Class: IconApi

[\<internal\>](../modules/internal_.md).IconApi

## Table of contents

### Constructors

- [constructor](internal_.IconApi.md#constructor)

### Methods

- [[kGetIconBlob]](internal_.IconApi.md#[kgeticonblob])
- [create](internal_.IconApi.md#create)
- [getIconUrl](internal_.IconApi.md#geticonurl)

## Constructors

### constructor

• **new IconApi**(`opts`): [`IconApi`](internal_.IconApi.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `opts` | `Object` |
| `opts.getMediaBaseUrl` | () => `Promise`\<`string`\> |
| `opts.iconDataStore` | [`DataStore`](internal_.DataStore.md)\<``"config"``, ``"translation"`` \| ``"projectSettings"`` \| ``"preset"`` \| ``"icon"`` \| ``"field"`` \| ``"deviceInfo"``\> |
| `opts.iconDataType` | [`DataType`](internal_.DataType.md)\<[`DataStore`](internal_.DataStore.md)\<``"config"``, ``"translation"`` \| ``"projectSettings"`` \| ``"preset"`` \| ``"icon"`` \| ``"field"`` \| ``"deviceInfo"``\>, `SQLiteTableWithColumns`\<{}\>, ``"icon"``, {}, {}\> |

#### Returns

[`IconApi`](internal_.IconApi.md)

## Methods

### [kGetIconBlob]

▸ **[kGetIconBlob]**(`iconId`, `opts`): `Promise`\<`Buffer`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `iconId` | `string` |
| `opts` | [`BitmapOpts`](../interfaces/internal_.BitmapOpts.md) \| [`SvgOpts`](../interfaces/internal_.SvgOpts.md) |

#### Returns

`Promise`\<`Buffer`\>

___

### create

▸ **create**(`icon`): `Promise`\<`string`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `icon` | `Object` |
| `icon.name` | `string` |
| `icon.variants` | [`BitmapOpts`](../interfaces/internal_.BitmapOpts.md) \| [`SvgOpts`](../interfaces/internal_.SvgOpts.md) & \{ `blob`: `Buffer`  }[] |

#### Returns

`Promise`\<`string`\>

___

### getIconUrl

▸ **getIconUrl**(`iconId`, `opts`): `Promise`\<`string`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `iconId` | `string` |
| `opts` | [`BitmapOpts`](../interfaces/internal_.BitmapOpts.md) \| [`SvgOpts`](../interfaces/internal_.SvgOpts.md) |

#### Returns

`Promise`\<`string`\>
