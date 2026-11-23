// Builds the Wiktionary dictionary pack from a Kaikki wiktextract extract.
//
//   npx tsx scripts/build-dictionary.ts --input <english.jsonl.gz> --output <pack> [--stats <stats.json>]
//     [--snapshot YYYY-MM-DD] [--examples 2] [--example-chars 240] [--no-labels]
//     [--include-pos <pos>]... [--exclude-pos <pos>]... [--block-size 65536]
//     [--sort-chunk-mb 64] [--temp-dir <dir>] [--level 9]
//
// The extract is read as a stream (gzip or plain JSONL). Each record goes
// through transformEntry (src/dict/kaikki.ts); the entries are sorted by key
// with an external merge sort over plain files in a temporary directory, so
// memory stays bounded; then the pack is written block by block. The order of
// entries under one key is spelling, then position in the extract, so the
// same input gives a byte-identical pack however the sort is split (for one
// Node.js build: the blocks are compressed with Node's zlib). See
// docs/pack-format.md and docs/dictionary-build.md.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createHash } from 'node:crypto'
import { createGunzip, gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SCOPE, transformEntry, type ScopeOptions, type SkipReason } from '../src/dict/kaikki'
import { compareKeys, DEFAULT_BLOCK_SIZE, type PackEntry, type PackMeta, type PackRecord } from '../src/dict/pack-format'
import { PackWriter } from '../src/dict/pack-writer'

export interface BuildOptions {
  input: string
  output: string
  statsPath?: string
  /** The extract's date; taken from a YYYY-MM-DD in the file name when not given. */
  snapshot?: string
  tempDir?: string
  /** Serialised bytes of entries sorted in memory before a run is written to disk. */
  sortChunkBytes?: number
  blockSize?: number
  /** gzip level for blocks and index, 0–9. */
  compressionLevel?: number
  scope?: Partial<ScopeOptions>
}

export interface BuildStats {
  input: { file: string; sha256: string; lines: number; records: number }
  snapshot: string
  options: ScopeOptions
  keys: number
  entries: number
  meanings: number
  examples: number
  pointers: number
  skipped: Partial<Record<SkipReason, number>>
  excludedByPos: Record<string, number>
  droppedSenses: number
  cleanedGlosses: number
  /** Meanings stored under one key (pointers not followed), over keys with at least one meaning. */
  meaningsPerKey: { keysWithMeanings: number; p50: number; p90: number; p99: number; p999: number; max: number }
  largestKeys: Array<{ key: string; meanings: number }>
  pack: { bytes: number; sha256: string; blocks: number; indexBytes: number }
}

/** An entry on its way through the sort; `seq` is its line in the extract. */
export interface SortItem { key: string; w: string; seq: number; entry: PackEntry }

const DEFAULT_SORT_CHUNK_BYTES = 64 * 1024 * 1024
const LARGEST_KEYS = 20

const compareItems = (a: SortItem, b: SortItem) => compareKeys(a.key, b.key) || compareKeys(a.w, b.w) || a.seq - b.seq
const serialise = (item: SortItem) => JSON.stringify([item.key, item.w, item.seq, item.entry])
const parseItem = (line: string): SortItem => { const [key, w, seq, entry] = JSON.parse(line) as [string, string, number, PackEntry]; return { key, w, seq, entry } }

/**
 * Sorts items by key, spelling and sequence. Items are kept in memory until
 * `chunkBytes` of them are buffered, then written to a sorted run file; the
 * runs are merged at the end. The temporary files are removed when the
 * consumer finishes or stops early.
 */
export async function* externalSort(items: AsyncIterable<SortItem>, options: { chunkBytes: number; tempDir?: string }): AsyncGenerator<SortItem> {
  let dir: string | undefined
  const runs: string[] = []
  let chunk: Array<{ item: SortItem; line: string }> = []
  let bytes = 0
  const spill = async () => {
    dir ??= await fsp.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), 'cd-sort-'))
    chunk.sort((a, b) => compareItems(a.item, b.item))
    const file = path.join(dir, `run-${runs.length}.jsonl`)
    await fsp.writeFile(file, chunk.map(({ line }) => `${line}\n`).join(''))
    runs.push(file)
    chunk = []
    bytes = 0
  }
  try {
    for await (const item of items) {
      const line = serialise(item)
      // Only the sort fields stay as objects; the entry waits as its JSON.
      chunk.push({ item: { key: item.key, w: item.w, seq: item.seq, entry: undefined as unknown as PackEntry }, line })
      bytes += line.length
      if (bytes >= options.chunkBytes) await spill()
    }
    if (!runs.length) {
      chunk.sort((a, b) => compareItems(a.item, b.item))
      for (const { line } of chunk) yield parseItem(line)
      return
    }
    if (chunk.length) await spill()
    yield* mergeRuns(runs)
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
  }
}

async function* mergeRuns(files: string[]): AsyncGenerator<SortItem> {
  const readers = files.map(file => {
    const stream = fs.createReadStream(file)
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
    return { stream, lines, iterator: lines[Symbol.asyncIterator]() }
  })
  try {
    const heads: Array<SortItem | undefined> = []
    const next = async (i: number) => { const result = await readers[i]!.iterator.next(); heads[i] = result.done ? undefined : parseItem(result.value) }
    for (let i = 0; i < readers.length; i++) await next(i)
    for (;;) {
      let best = -1
      for (let i = 0; i < heads.length; i++) if (heads[i] && (best < 0 || compareItems(heads[i]!, heads[best]!) < 0)) best = i
      if (best < 0) return
      yield heads[best]!
      await next(best)
    }
  } finally {
    for (const reader of readers) { reader.lines.close(); reader.stream.destroy() }
  }
}

/** Nearest-rank percentile `q` (0–1) of a histogram value → count. */
export function percentile(histogram: Map<number, number>, q: number): number {
  const total = [...histogram.values()].reduce((sum, count) => sum + count, 0)
  if (!total) return 0
  const rank = Math.max(1, Math.ceil(q * total))
  let seen = 0
  for (const value of [...histogram.keys()].sort((a, b) => a - b)) {
    seen += histogram.get(value)!
    if (seen >= rank) return value
  }
  /* c8 ignore next */
  return 0
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function isGzip(file: string): Promise<boolean> {
  const handle = await fsp.open(file, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0)
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  } finally {
    await handle.close()
  }
}

/** Builds the pack (and stats file) described by `options`; returns the stats. */
export async function buildDictionary(options: BuildOptions): Promise<BuildStats> {
  const scope: ScopeOptions = { ...DEFAULT_SCOPE, ...options.scope }
  const file = path.basename(options.input)
  const inputSha = await sha256File(options.input)
  const snapshot = options.snapshot ?? /\d{4}-\d{2}-\d{2}/.exec(file)?.[0] ?? 'unknown'
  const level = options.compressionLevel ?? 9
  const meta: PackMeta = { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: `${file} sha256:${inputSha}`, snapshot, options: { ...scope } }

  const counts = { lines: 0, records: 0, entries: 0, meanings: 0, examples: 0, pointers: 0, droppedSenses: 0, cleanedGlosses: 0, keys: 0 }
  const skipped: Partial<Record<SkipReason, number>> = {}
  const excludedByPos: Record<string, number> = {}

  async function* transformed(): AsyncGenerator<SortItem> {
    let input: NodeJS.ReadableStream = fs.createReadStream(options.input)
    if (await isGzip(options.input)) input = input.pipe(createGunzip())
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      counts.lines++
      if (!line.trim()) continue
      counts.records++
      let raw: unknown
      try { raw = JSON.parse(line) } catch { throw new Error(`${file}: line ${counts.lines} is not JSON`) }
      const result = transformEntry(raw, scope)
      if (!result.ok) {
        skipped[result.reason] = (skipped[result.reason] ?? 0) + 1
        if (result.reason === 'excluded-pos') { const pos = (raw as { pos: string }).pos; excludedByPos[pos] = (excludedByPos[pos] ?? 0) + 1 }
        continue
      }
      counts.entries++
      counts.droppedSenses += result.droppedSenses
      counts.cleanedGlosses += result.cleanedGlosses
      counts.meanings += result.entry.s?.length ?? 0
      counts.pointers += result.entry.f?.length ?? 0
      for (const sense of result.entry.s ?? []) if (typeof sense !== 'string') counts.examples += sense.length - 1
      yield { key: result.key, w: result.entry.w, seq: counts.lines, entry: result.entry }
    }
  }

  const histogram = new Map<number, number>()
  const largest: Array<{ key: string; meanings: number }> = []
  const record = (key: string, entries: PackEntry[]): PackRecord => {
    counts.keys++
    const meanings = entries.reduce((sum, entry) => sum + (entry.s?.length ?? 0), 0)
    if (meanings) histogram.set(meanings, (histogram.get(meanings) ?? 0) + 1)
    if (meanings && (largest.length < LARGEST_KEYS || meanings > largest.at(-1)!.meanings)) {
      largest.push({ key, meanings })
      largest.sort((a, b) => b.meanings - a.meanings || compareKeys(a.key, b.key))
      largest.length = Math.min(largest.length, LARGEST_KEYS)
    }
    return { k: key, e: entries }
  }

  const bodyPath = `${options.output}.body.tmp`
  const outputTmp = `${options.output}.tmp`
  await fsp.mkdir(path.dirname(path.resolve(options.output)), { recursive: true })
  const body = await fsp.open(bodyPath, 'w')
  try {
    const writer = new PackWriter({
      meta,
      blockSize: options.blockSize ?? DEFAULT_BLOCK_SIZE,
      compress: data => gzipSync(data, { level }),
      write: async chunk => { await body.write(chunk) },
    })
    let key: string | undefined
    let entries: PackEntry[] = []
    for await (const item of externalSort(transformed(), { chunkBytes: options.sortChunkBytes ?? DEFAULT_SORT_CHUNK_BYTES, tempDir: options.tempDir })) {
      if (item.key !== key) {
        if (key !== undefined) await writer.add(record(key, entries))
        key = item.key
        entries = []
      }
      entries.push(item.entry)
    }
    if (key !== undefined) await writer.add(record(key, entries))
    const { prefix, index, header } = await writer.finish()
    await body.close()

    // The file is prefix + blocks + index, written next to the output and moved into place.
    const hash = createHash('sha256')
    const out = await fsp.open(outputTmp, 'w')
    try {
      const write = async (bytes: Uint8Array) => { hash.update(bytes); await out.write(bytes) }
      await write(prefix)
      for await (const chunk of fs.createReadStream(bodyPath)) await write(chunk as Buffer)
      await write(index)
    } finally {
      await out.close()
    }
    await fsp.rename(outputTmp, options.output)

    const stats: BuildStats = {
      input: { file, sha256: inputSha, lines: counts.lines, records: counts.records },
      snapshot,
      options: scope,
      keys: counts.keys,
      entries: counts.entries,
      meanings: counts.meanings,
      examples: counts.examples,
      pointers: counts.pointers,
      skipped,
      excludedByPos,
      droppedSenses: counts.droppedSenses,
      cleanedGlosses: counts.cleanedGlosses,
      meaningsPerKey: {
        keysWithMeanings: [...histogram.values()].reduce((sum, count) => sum + count, 0),
        p50: percentile(histogram, 0.5), p90: percentile(histogram, 0.9), p99: percentile(histogram, 0.99), p999: percentile(histogram, 0.999),
        max: Math.max(0, ...histogram.keys()),
      },
      largestKeys: largest,
      pack: { bytes: header.indexOffset + header.indexLength, sha256: hash.digest('hex'), blocks: header.blockCount, indexBytes: header.indexLength },
    }
    if (options.statsPath) await fsp.writeFile(options.statsPath, `${JSON.stringify(stats, null, 2)}\n`)
    return stats
  } finally {
    await body.close().catch(() => {})
    await fsp.rm(bodyPath, { force: true })
    await fsp.rm(outputTmp, { force: true })
  }
}

function count(name: string, value: string | undefined, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) > max) throw new Error(`--${name} must be a whole number${max < Number.MAX_SAFE_INTEGER ? ` from 0 to ${max}` : ''}`)
  return Number(value)
}

/** The build options from command-line arguments. */
export function parseArguments(argv: string[]): BuildOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: 'string' }, output: { type: 'string' }, stats: { type: 'string' }, snapshot: { type: 'string' },
      examples: { type: 'string' }, 'example-chars': { type: 'string' }, 'no-labels': { type: 'boolean' },
      'include-pos': { type: 'string', multiple: true }, 'exclude-pos': { type: 'string', multiple: true },
      'block-size': { type: 'string' }, 'sort-chunk-mb': { type: 'string' }, 'temp-dir': { type: 'string' }, level: { type: 'string' },
    },
  })
  if (!values.input) throw new Error('--input <Kaikki jsonl or jsonl.gz> is required')
  if (!values.output) throw new Error('--output <pack file> is required')
  const scope: Partial<ScopeOptions> = {}
  const maxExamples = count('examples', values.examples)
  if (maxExamples !== undefined) scope.maxExamples = maxExamples
  const maxExampleChars = count('example-chars', values['example-chars'])
  if (maxExampleChars !== undefined) scope.maxExampleChars = maxExampleChars
  if (values['no-labels']) scope.labels = false
  if (values['include-pos'] || values['exclude-pos']) {
    const include = values['include-pos'] ?? []
    scope.excludedPos = [...DEFAULT_SCOPE.excludedPos.filter(pos => !include.includes(pos)), ...(values['exclude-pos'] ?? [])]
  }
  const sortChunkMb = count('sort-chunk-mb', values['sort-chunk-mb'])
  return {
    input: values.input,
    output: values.output,
    statsPath: values.stats,
    snapshot: values.snapshot,
    blockSize: count('block-size', values['block-size']),
    sortChunkBytes: sortChunkMb === undefined ? undefined : sortChunkMb * 1024 * 1024,
    tempDir: values['temp-dir'],
    compressionLevel: count('level', values.level, 9),
    scope,
  }
}

export async function main(argv: string[]): Promise<void> {
  const started = performance.now()
  const options = parseArguments(argv)
  const stats = await buildDictionary(options)
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`${options.output}: ${stats.entries} entries, ${stats.meanings} meanings, ${stats.pointers} pointers, ${stats.keys} keys`)
  console.log(`${stats.pack.bytes} bytes in ${stats.pack.blocks} blocks, sha256 ${stats.pack.sha256}`)
  console.log(`built in ${seconds} s, peak resident memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`)
}

/* c8 ignore next 3 */
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
