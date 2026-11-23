// Writes pack format v1 (docs/pack-format.md) from records given in key order.
// Portable: the default compressor is CompressionStream, and the caller
// decides where the bytes go, so the builder can stream blocks to a file and
// tests can keep everything in memory. The output depends only on the
// records, the metadata and the compressor.
import {
  compareKeys, DEFAULT_BLOCK_SIZE, gzipBytes, normalizeGzipHeader, PACK_MAGIC, PACK_VERSION, PREAMBLE_BYTES,
  type PackHeader, type PackIndexItem, type PackMeta, type PackRecord,
} from './pack-format'

export type Compressor = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>

export interface PackWriterOptions {
  meta: PackMeta
  /** Target size of a block before compression; a single larger record gets a block of its own. */
  blockSize?: number
  /** gzip compressor; its output must be one gzip member. Defaults to CompressionStream. */
  compress?: Compressor
  /** Receives the compressed blocks in order. */
  write: (chunk: Uint8Array) => void | Promise<void>
}

/** The bytes that go before and after the blocks, and the header they hold. */
export interface PackParts { prefix: Uint8Array; index: Uint8Array; header: PackHeader }

const encoder = new TextEncoder()

export class PackWriter {
  private readonly blockSize: number
  private readonly compress: Compressor
  private lines: string[] = []
  private pendingBytes = 0
  private firstKey = ''
  private lastKey: string | undefined
  private bodyBytes = 0
  private finished = false
  /** Offsets relative to the first block until finish(). */
  private readonly blocks: PackIndexItem[] = []
  private counts = { keyCount: 0, entryCount: 0, senseCount: 0, pointerCount: 0 }

  constructor(private readonly options: PackWriterOptions) {
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE
    this.compress = options.compress ?? gzipBytes
  }

  /** Adds one record. Keys must be non-empty and strictly increasing. */
  async add(record: PackRecord): Promise<void> {
    if (this.finished) throw new Error('The pack writer is finished')
    if (!record.k) throw new Error('A record key is empty')
    if (this.lastKey !== undefined && compareKeys(record.k, this.lastKey) <= 0) throw new Error(`Record keys are out of order: "${record.k}" after "${this.lastKey}"`)
    this.lastKey = record.k
    const line = `${JSON.stringify({ k: record.k, e: record.e })}\n`
    const size = encoder.encode(line).length
    if (this.lines.length && this.pendingBytes + size > this.blockSize) await this.flush()
    if (!this.lines.length) this.firstKey = record.k
    this.lines.push(line)
    this.pendingBytes += size
    this.counts.keyCount++
    this.counts.entryCount += record.e.length
    for (const entry of record.e) {
      this.counts.senseCount += entry.s?.length ?? 0
      this.counts.pointerCount += entry.f?.length ?? 0
    }
  }

  private async flush(): Promise<void> {
    const block = normalizeGzipHeader(await this.compress(encoder.encode(this.lines.join(''))))
    this.blocks.push({ firstKey: this.firstKey, offset: this.bodyBytes, length: block.length })
    this.bodyBytes += block.length
    this.lines = []
    this.pendingBytes = 0
    await this.options.write(block)
  }

  /**
   * Writes the last block and returns what goes before the blocks (magic,
   * version, header) and after them (the index). The file is
   * `prefix + blocks + index`.
   */
  async finish(): Promise<PackParts> {
    if (this.finished) throw new Error('The pack writer is finished')
    this.finished = true
    if (this.lines.length) await this.flush()
    // The header holds the index position and the index holds absolute
    // offsets, so the prefix length feeds back into both. Grow the guess until
    // it holds; a header that comes out shorter is padded with spaces, which
    // JSON allows, so the loop only ever grows and ends.
    let prefixLength = PREAMBLE_BYTES
    for (;;) {
      const items = this.blocks.map(block => ({ firstKey: block.firstKey, offset: block.offset + prefixLength, length: block.length }))
      const index = normalizeGzipHeader(await this.compress(encoder.encode(JSON.stringify(items))))
      const header: PackHeader = {
        format: 'cdpk',
        version: PACK_VERSION,
        ...this.options.meta,
        ...this.counts,
        blockCount: this.blocks.length,
        blockSize: this.blockSize,
        indexOffset: prefixLength + this.bodyBytes,
        indexLength: index.length,
      }
      let headerBytes = encoder.encode(JSON.stringify(header))
      const needed = PREAMBLE_BYTES + headerBytes.length
      if (needed > prefixLength) { prefixLength = needed; continue }
      if (needed < prefixLength) headerBytes = encoder.encode(JSON.stringify(header).padEnd(prefixLength - PREAMBLE_BYTES, ' '))
      const prefix = new Uint8Array(prefixLength)
      prefix.set(encoder.encode(PACK_MAGIC), 0)
      const view = new DataView(prefix.buffer)
      view.setUint32(4, PACK_VERSION, true)
      view.setUint32(8, headerBytes.length, true)
      prefix.set(headerBytes, PREAMBLE_BYTES)
      return { prefix, index, header }
    }
  }
}

/** A whole pack in memory, from records in key order. For tests and small packs. */
export async function writePack(records: Iterable<PackRecord> | AsyncIterable<PackRecord>, options: Omit<PackWriterOptions, 'write'>): Promise<Uint8Array> {
  const blocks: Uint8Array[] = []
  const writer = new PackWriter({ ...options, write: chunk => { blocks.push(chunk) } })
  for await (const record of records) await writer.add(record)
  const { prefix, index } = await writer.finish()
  const out = new Uint8Array(prefix.length + blocks.reduce((sum, block) => sum + block.length, 0) + index.length)
  let at = 0
  for (const part of [prefix, ...blocks, index]) { out.set(part, at); at += part.length }
  return out
}
