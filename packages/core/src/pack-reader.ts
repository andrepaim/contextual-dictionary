// Reads pack format v1 (docs/pack-format.md) by byte range. Runs in the
// browser and in Node 22: no Node built-ins. The header and index are read
// once; each lookup reads and inflates at most one block, and a small LRU
// keeps recently inflated blocks.
import { CodedError, type ByteSource } from './contracts.js'
import { compareKeys, gunzipBytes, PACK_MAGIC, PACK_VERSION, PREAMBLE_BYTES, type PackHeader, type PackIndexItem, type PackRecord } from './pack-format.js'

export interface PackReaderOptions {
  /** How many inflated blocks to keep. Default 16 (about 1 MB of text). */
  cacheBlocks?: number
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

const corrupt = (message: string, details?: Record<string, unknown>) => new CodedError('PACK_CORRUPT', message, details)

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw corrupt(`The pack ${what} is not valid JSON`)
  }
}

/** A ByteSource over bytes in memory. */
export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (start, end) => {
      if (!(start >= 0 && start <= end && end <= bytes.length)) throw new RangeError(`Read ${start}–${end} is outside 0–${bytes.length}`)
      return bytes.subarray(start, end)
    },
  }
}

export class PackReader {
  private readonly cache = new Map<number, Promise<Map<string, PackRecord>>>()
  private readonly cacheBlocks: number

  private constructor(
    private readonly source: ByteSource,
    readonly header: PackHeader,
    private readonly index: PackIndexItem[],
    options: PackReaderOptions,
  ) {
    this.cacheBlocks = Math.max(1, options.cacheBlocks ?? 16)
  }

  /** Opens a pack: checks magic, version and header, and loads the index. */
  static async open(source: ByteSource, options: PackReaderOptions = {}): Promise<PackReader> {
    if (source.size < PREAMBLE_BYTES) throw new CodedError('PACK_INVALID', 'The file is too short to be a dictionary pack')
    const preamble = await read(source, 0, PREAMBLE_BYTES)
    if (String.fromCharCode(...preamble.subarray(0, 4)) !== PACK_MAGIC) throw new CodedError('PACK_INVALID', 'The file is not a dictionary pack')
    const view = new DataView(preamble.buffer, preamble.byteOffset, preamble.byteLength)
    const version = view.getUint32(4, true)
    if (version !== PACK_VERSION) throw new CodedError('PACK_UNSUPPORTED_VERSION', `Dictionary pack version ${version} is not supported`, { version })
    const headerLength = view.getUint32(8, true)
    const headerEnd = PREAMBLE_BYTES + headerLength
    if (headerEnd > source.size) throw corrupt('The pack header is truncated')
    const header = checkHeader(parseJson(await read(source, PREAMBLE_BYTES, headerEnd), 'header'), headerEnd, source.size)
    let indexJson: unknown
    try {
      indexJson = parseJson(await gunzipBytes(await read(source, header.indexOffset, header.indexOffset + header.indexLength)), 'index')
    } catch (error) {
      throw error instanceof CodedError ? error : corrupt('The pack index does not inflate')
    }
    return new PackReader(source, header, checkIndex(indexJson, header, headerEnd), options)
  }

  /** The record stored under `key` (already normalised), or undefined. */
  async get(key: string): Promise<PackRecord | undefined> {
    // The last block whose first key is not after `key`.
    let low = 0, high = this.index.length - 1, found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (compareKeys(this.index[middle]!.firstKey, key) <= 0) { found = middle; low = middle + 1 } else high = middle - 1
    }
    if (found < 0) return undefined
    return (await this.block(found)).get(key)
  }

  private block(number: number): Promise<Map<string, PackRecord>> {
    const cached = this.cache.get(number)
    if (cached) {
      this.cache.delete(number)
      this.cache.set(number, cached)
      return cached
    }
    const loading = this.load(number)
    this.cache.set(number, loading)
    loading.catch(() => { if (this.cache.get(number) === loading) this.cache.delete(number) })
    while (this.cache.size > this.cacheBlocks) this.cache.delete(this.cache.keys().next().value!)
    return loading
  }

  private async load(number: number): Promise<Map<string, PackRecord>> {
    const item = this.index[number]!
    const compressed = await read(this.source, item.offset, item.offset + item.length)
    let text: string
    try {
      text = decoder.decode(await gunzipBytes(compressed))
    } catch {
      throw corrupt(`Dictionary block ${number} does not inflate`, { block: number })
    }
    const records = new Map<string, PackRecord>()
    let previous: string | undefined
    if (!text.endsWith('\n')) throw corrupt(`Dictionary block ${number} is incomplete`, { block: number })
    for (const line of text.slice(0, -1).split('\n')) {
      let record: unknown
      try { record = JSON.parse(line) } catch { throw corrupt(`Dictionary block ${number} holds a line that is not JSON`, { block: number }) }
      if (!isRecord(record) || typeof record.k !== 'string' || !Array.isArray(record.e)) throw corrupt(`Dictionary block ${number} holds a malformed record`, { block: number })
      if (previous === undefined ? record.k !== item.firstKey : compareKeys(record.k, previous) <= 0) throw corrupt(`Dictionary block ${number} is out of order`, { block: number })
      previous = record.k
      records.set(record.k, record as unknown as PackRecord)
    }
    return records
  }
}

async function read(source: ByteSource, start: number, end: number): Promise<Uint8Array> {
  try {
    const bytes = await source.read(start, end)
    if (bytes.length !== end - start) throw new Error('short read')
    return bytes
  } catch (error) {
    throw new CodedError('PACK_READ_FAILED', 'The dictionary file could not be read', { cause: error instanceof Error ? error.message : String(error) })
  }
}

function checkHeader(value: unknown, headerEnd: number, size: number): PackHeader {
  if (!isRecord(value) || value.format !== 'cdpk' || value.version !== PACK_VERSION) throw corrupt('The pack header is not a version 1 header')
  for (const field of ['keyCount', 'entryCount', 'senseCount', 'pointerCount', 'blockCount', 'blockSize', 'indexOffset', 'indexLength'])
    if (!isCount(value[field])) throw corrupt(`The pack header field ${field} is invalid`)
  const header = value as unknown as PackHeader
  if (header.indexOffset < headerEnd || header.indexOffset + header.indexLength !== size) throw corrupt('The pack is truncated or its index is misplaced', { size })
  return header
}

function checkIndex(value: unknown, header: PackHeader, headerEnd: number): PackIndexItem[] {
  if (!Array.isArray(value) || value.length !== header.blockCount) throw corrupt('The pack index does not match the header')
  let expected = headerEnd
  let previous: string | undefined
  const items: PackIndexItem[] = []
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item.firstKey !== 'string' || !isCount(item.offset) || !isCount(item.length) || item.length === 0) throw corrupt('The pack index holds a malformed block')
    if (item.offset !== expected) throw corrupt('The pack index does not match the blocks')
    if (previous !== undefined && compareKeys(item.firstKey, previous) <= 0) throw corrupt('The pack index is out of order')
    expected = item.offset + item.length
    previous = item.firstKey
    items.push({ firstKey: item.firstKey, offset: item.offset, length: item.length })
  }
  if (expected !== header.indexOffset) throw corrupt('The pack index does not match the blocks')
  return items
}
