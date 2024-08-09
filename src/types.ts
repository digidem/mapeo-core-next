import type {
  Simplify,
  TupleToUnion,
  ValueOf,
  RequireAtLeastOne,
  SetOptional,
} from 'type-fest'
import { SUPPORTED_BLOB_VARIANTS } from './blob-store/index.js'
import { MapeoCommon, MapeoDoc, MapeoValue, decode } from '@mapeo/schema'
import type BigSparseArray from 'big-sparse-array'
import type Protomux from 'protomux'
import type NoiseStream from '@hyperswarm/secret-stream'
import { Duplex } from 'streamx'
import RandomAccessStorage from 'random-access-storage'
import { DefaultListener, ListenerSignature } from 'tiny-typed-emitter'

type SupportedBlobVariants = typeof SUPPORTED_BLOB_VARIANTS
export type BlobType = keyof SupportedBlobVariants
export type BlobVariant<TBlobType extends BlobType> = TupleToUnion<
  SupportedBlobVariants[TBlobType]
>

type BlobIdBase<T extends BlobType> = {
  /** Type of blob */
  type: T
  /** Blob variant (some blob types have smaller previews and thumbnails available) */
  variant: BlobVariant<T>
  /** unique identifier for blob (e.g. hash of content) */
  name: string
  /** discovery key as hex string of hyperdrive where blob is stored */
  driveId: string
}

// Ugly, but the only way I could figure out how to get what I wanted
export type BlobId = Simplify<
  ValueOf<{
    [KeyType in BlobType]: BlobIdBase<KeyType>
  }>
>

type ArrayAtLeastOne<T> = [T, ...T[]]

export type BlobFilter = RequireAtLeastOne<{
  [KeyType in BlobType]: ArrayAtLeastOne<BlobVariant<KeyType>>
}>

export type MapeoDocMap = {
  [K in MapeoDoc['schemaName']]: Extract<MapeoDoc, { schemaName: K }>
}

export type MapeoValueMap = {
  [K in MapeoValue['schemaName']]: Extract<MapeoValue, { schemaName: K }>
}

// TODO: Replace this with exports from @mapeo/schema
export type CoreOwnershipWithSignatures = Extract<
  ReturnType<typeof decode>,
  { schemaName: 'coreOwnership' }
>
export type CoreOwnershipWithSignaturesValue = Omit<
  CoreOwnershipWithSignatures,
  Exclude<keyof MapeoCommon, 'schemaName'>
>

type NullToOptional<T> = SetOptional<T, NullKeys<T>>
type RemoveNull<T> = {
  [K in keyof T]: Exclude<T[K], null>
}

type NullKeys<Base> = NonNullable<
  // Wrap in `NonNullable` to strip away the `undefined` type from the produced union.
  {
    // Map through all the keys of the given base type.
    [Key in keyof Base]: null extends Base[Key] // Pick only keys with types extending the given `Condition` type.
      ? // Retain this key since the condition passes.
        Key
      : // Discard this key since the condition fails.
        never

    // Convert the produced object into a union type of the keys which passed the conditional test.
  }[keyof Base]
>

/**
 * Replace an object's `Buffer` values with `string`s. Useful for serialization.
 */
export type MapBuffers<T> = {
  [K in keyof T]: T[K] extends Buffer ? string : T[K]
}

/**
 * Make any properties whose value include `null` optional, and remove `null`
 * from the type. This converts the types returned from SQLite (which have all
 * top-level optional props set to `null`) to the original types in
 * @mapeo/schema
 */
export type NullableToOptional<T> = Simplify<RemoveNull<NullToOptional<T>>>
export type KeyPair = {
  publicKey: PublicKey
  secretKey: SecretKey
}

/** 32 byte buffer */
export type PublicKey = Buffer
/** 32 byte buffer */
export type SecretKey = Buffer
export type IdentityKeyPair = KeyPair

type HypercoreRemoteBitfieldPage = {
  bitfield: Uint32Array
}

/**
 * A subset of Hypercore's `RemoteBitfield` class that we use.
 */
export type HypercoreRemoteBitfield = {
  _pages: BigSparseArray<HypercoreRemoteBitfieldPage>
  get(index: number): boolean
}

/**
 * A subset of Hypercore's `Peer` class that we use.
 * TODO: Contribute these types upstream.
 */
export type HypercorePeer = {
  protomux: Protomux
  remotePublicKey: Buffer
  remoteBitfield: HypercoreRemoteBitfield
  onbitfield: (options: { start: number; bitfield: Buffer }) => void
  onrange: (options: { drop: boolean; start: number; length: number }) => void
}

export { NoiseStream }
type ProtocolStream = Omit<NoiseStream, 'userData'> & {
  userData: Protomux
}
export type ReplicationStream = Duplex & { noiseStream: ProtocolStream }

export type CoreStorage = (name: string) => RandomAccessStorage

export type DefaultEmitterEvents<
  L extends ListenerSignature<L> = DefaultListener
> = {
  newListener: (event: keyof L, listener: L[keyof L]) => void
  removeListener: (event: keyof L, listener: L[keyof L]) => void
}
