// Pack format v1: one file, little-endian (docs/pack-format.md).
//
//   magic "CDPK" | u32 version | u32 headerLength | header JSON (UTF-8)
//   blocks…   each a gzip member holding newline-terminated JSON records in key order
//   index     a gzip member holding JSON [{ firstKey, offset, length }]
//
// Runs in the browser and in Node 22: no Node built-ins here.

export const PACK_MAGIC = 'CDPK'
export const PACK_VERSION = 1
/** Magic, version and header length. */
export const PREAMBLE_BYTES = 12
/** Target size of a block before compression. */
export const DEFAULT_BLOCK_SIZE = 64 * 1024

/** A meaning: its definition, or its definition followed by its examples. */
export type PackSense = string | [string, ...string[]]

/** An inflection pointer: the base word `l` as spelled, and the inflection's own gloss `n`, e.g. "plural of mouse". */
export interface PackPointer { l: string; n: string }

/**
 * One dictionary entry: spelling `w`, part of speech `p`, meanings `s`, and
 * inflection pointers `f`. An entry has meanings, pointers or both.
 */
export interface PackEntry { w: string; p: string; s?: PackSense[]; f?: PackPointer[] }

/** Everything stored under one lookup key, entries in dictionary order. */
export interface PackRecord { k: string; e: PackEntry[] }

/** What the writer's caller says about the pack. */
export interface PackMeta {
  language: string
  source: string
  license: string
  createdFrom: string
  snapshot: string
  /** The builder's scope options, recorded for provenance. */
  options?: Record<string, unknown>
}

export interface PackHeader extends PackMeta {
  format: 'cdpk'
  version: number
  keyCount: number
  entryCount: number
  senseCount: number
  pointerCount: number
  blockCount: number
  blockSize: number
  indexOffset: number
  indexLength: number
}

/** One block: the key of its first record, its absolute byte offset and its compressed length. */
export interface PackIndexItem { firstKey: string; offset: number; length: number }

/** Key order: UTF-16 code units, the order of JavaScript's `<` on strings. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function transform(bytes: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(output).arrayBuffer())
}

/**
 * Sets the gzip header's time to zero and its OS byte to 255 ("unknown"), so
 * the same data compresses to the same bytes on every platform. The header
 * carries no checksum of its own unless FHCRC is set, which is then left alone.
 */
export function normalizeGzipHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 10 && bytes[0] === 0x1f && bytes[1] === 0x8b && (bytes[3]! & 0x02) === 0) {
    bytes.fill(0, 4, 8)
    bytes[9] = 255
  }
  return bytes
}

/** gzip with the platform's CompressionStream, with a normalised header. */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return normalizeGzipHeader(await transform(bytes, new CompressionStream('gzip')))
}

/** Inflates one gzip member with DecompressionStream. Rejects on bad or truncated data. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new DecompressionStream('gzip'))
}
