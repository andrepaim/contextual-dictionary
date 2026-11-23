import { describe, expect, test } from 'vitest'
import { gzipSync, gunzipSync } from 'node:zlib'
import { CodedError, type ByteSource } from '../../../src/shared/contracts'
import { compareKeys, gunzipBytes, gzipBytes, PACK_MAGIC, PACK_VERSION, PREAMBLE_BYTES, type PackHeader, type PackIndexItem, type PackMeta, type PackRecord } from '../../../src/dict/pack-format'
import { PackWriter, writePack } from '../../../src/dict/pack-writer'
import { memoryByteSource, PackReader } from '../../../src/dict/pack-reader'
import { RECORDS } from '../../fixtures/dict/records'

const META: PackMeta = { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'fixture', snapshot: '2026-10-30' }
const sorted = (records: PackRecord[]) => [...records].sort((a, b) => compareKeys(a.k, b.k))

/** Many small records whose keys sort in numeric order, enough for several blocks. */
function manyRecords(count: number): PackRecord[] {
  return Array.from({ length: count }, (_, i) => ({ k: `word${String(i).padStart(5, '0')}`, e: [{ w: `word${i}`, p: 'noun', s: [`Meaning number ${i}.`] }] }))
}

/** A ByteSource that counts its reads. */
function countingSource(bytes: Uint8Array): ByteSource & { reads: Array<[number, number]> } {
  const inner = memoryByteSource(bytes)
  const reads: Array<[number, number]> = []
  return { size: inner.size, reads, read: (start, end) => { reads.push([start, end]); return inner.read(start, end) } }
}

function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }

function parsePack(bytes: Uint8Array): { header: PackHeader; index: PackIndexItem[]; headerEnd: number } {
  const headerLength = view(bytes).getUint32(8, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength))) as PackHeader
  const index = JSON.parse(gunzipSync(bytes.subarray(header.indexOffset, header.indexOffset + header.indexLength)).toString('utf8')) as PackIndexItem[]
  return { header, index, headerEnd: PREAMBLE_BYTES + headerLength }
}

/** A copy of `bytes` with the header replaced, the rest moved to match. */
function withHeader(bytes: Uint8Array, change: (header: Record<string, unknown>) => Record<string, unknown> | string): Uint8Array {
  const { header, headerEnd } = parsePack(bytes)
  const next = change({ ...header })
  const text = new TextEncoder().encode(typeof next === 'string' ? next : JSON.stringify(next))
  const out = new Uint8Array(PREAMBLE_BYTES + text.length + bytes.length - headerEnd)
  out.set(bytes.subarray(0, PREAMBLE_BYTES))
  view(out).setUint32(8, text.length, true)
  out.set(text, PREAMBLE_BYTES)
  out.set(bytes.subarray(headerEnd), PREAMBLE_BYTES + text.length)
  return out
}

/** A copy of `bytes` with the index replaced by `raw` (already compressed or not). */
function withIndex(bytes: Uint8Array, raw: Uint8Array): Uint8Array {
  const { header } = parsePack(bytes)
  const body = bytes.subarray(0, header.indexOffset)
  const out = new Uint8Array(body.length + raw.length)
  out.set(body)
  out.set(raw, body.length)
  return withHeader(out, h => ({ ...h, indexLength: raw.length }))
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(CodedError)
  expect((error as CodedError).code).toBe(code)
}

describe('pack format helpers', () => {
  test('compareKeys orders by UTF-16 code units', () => {
    expect(['b', 'a b', 'a', 'B', 'ab', 'é', 'a-'].sort(compareKeys)).toEqual(['B', 'a', 'a b', 'a-', 'ab', 'b', 'é'])
    expect(compareKeys('x', 'x')).toBe(0)
  })

  test('gzipBytes output is a single gzip member that zlib reads, with a fixed header', async () => {
    const data = new TextEncoder().encode('hello hello hello hello')
    const packed = await gzipBytes(data)
    expect(gunzipSync(packed).toString()).toBe('hello hello hello hello')
    expect([...packed.subarray(4, 8)]).toEqual([0, 0, 0, 0])
    expect(packed[9]).toBe(255)
    expect(new TextDecoder().decode(await gunzipBytes(gzipSync(Buffer.from('round trip'))))).toBe('round trip')
  })
})

describe('writePack and PackReader', () => {
  test('round-trips every record and reports the header', async () => {
    const records = sorted(RECORDS)
    const bytes = await writePack(records, { meta: META })
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe(PACK_MAGIC)
    expect(view(bytes).getUint32(4, true)).toBe(PACK_VERSION)
    const reader = await PackReader.open(memoryByteSource(bytes))
    for (const record of records) expect(await reader.get(record.k)).toEqual(record)
    const header = reader.header
    expect(header).toMatchObject({ ...META, format: 'cdpk', version: 1, keyCount: records.length, blockCount: 1 })
    expect(header.entryCount).toBe(records.reduce((sum, r) => sum + r.e.length, 0))
    expect(header.senseCount).toBe(records.reduce((sum, r) => sum + r.e.reduce((n, e) => n + (e.s?.length ?? 0), 0), 0))
    expect(header.pointerCount).toBe(records.reduce((sum, r) => sum + r.e.reduce((n, e) => n + (e.f?.length ?? 0), 0), 0))
    expect(header.indexOffset + header.indexLength).toBe(bytes.length)
  })

  test('returns undefined for keys that are missing before, between and after the stored keys', async () => {
    const reader = await PackReader.open(memoryByteSource(await writePack(manyRecords(3000), { meta: META, blockSize: 4096 })))
    expect(reader.header.blockCount).toBeGreaterThan(10)
    for (const key of ['', '0', 'aaa', 'word', 'word00001x', 'word0150', 'word02999 ', 'word03000', 'zzz', '￿']) expect(await reader.get(key), key).toBeUndefined()
  })

  test('finds the first and last key of every block', async () => {
    const records = manyRecords(3000)
    const bytes = await writePack(records, { meta: META, blockSize: 2048 })
    const { index } = parsePack(bytes)
    const reader = await PackReader.open(memoryByteSource(bytes))
    const byKey = new Map(records.map(r => [r.k, r]))
    for (let i = 0; i < index.length; i++) {
      const first = index[i]!.firstKey
      expect(await reader.get(first)).toEqual(byKey.get(first))
      const nextFirst = index[i + 1]?.firstKey
      const last = records[(nextFirst ? records.findIndex(r => r.k === nextFirst) : records.length) - 1]!
      expect(await reader.get(last.k)).toEqual(last)
    }
  })

  test('blocks stay near the target size, and a record larger than a block gets its own', async () => {
    const big: PackRecord = { k: 'word01000a', e: [{ w: 'huge', p: 'noun', s: Array.from({ length: 400 }, (_, i) => `Meaning ${i} of a very large entry.`) }] }
    const records = sorted([...manyRecords(2000), big])
    const bytes = await writePack(records, { meta: META, blockSize: 4096 })
    const { index, header } = parsePack(bytes)
    let previousEnd = PREAMBLE_BYTES + view(bytes).getUint32(8, true)
    for (const item of index) {
      expect(item.offset).toBe(previousEnd)
      previousEnd = item.offset + item.length
      const text = gunzipSync(bytes.subarray(item.offset, item.offset + item.length)).toString('utf8')
      expect(text.endsWith('\n')).toBe(true)
      const lines = text.trimEnd().split('\n')
      expect(text.length <= 4096 || lines.length === 1).toBe(true)
      expect(JSON.parse(lines[0]!).k).toBe(item.firstKey)
    }
    expect(previousEnd).toBe(header.indexOffset)
    expect(index.some(item => item.firstKey === big.k)).toBe(true)
    expect(await (await PackReader.open(memoryByteSource(bytes))).get(big.k)).toEqual(big)
  })

  test('the same records give byte-identical packs', async () => {
    const records = sorted(RECORDS)
    const a = await writePack(records, { meta: META, blockSize: 512 })
    const b = await writePack(records.map(r => structuredClone(r)), { meta: META, blockSize: 512 })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  test('takes an async iterable, a custom compressor and options recorded in the header', async () => {
    async function* records() { yield* sorted(RECORDS) }
    const bytes = await writePack(records(), { meta: { ...META, options: { maxExamples: 2 } }, compress: data => gzipSync(data, { level: 9 }) })
    const reader = await PackReader.open(memoryByteSource(bytes))
    expect(reader.header.options).toEqual({ maxExamples: 2 })
    expect(await reader.get('mouse')).toEqual(RECORDS[0])
  })

  test('an empty pack opens and finds nothing', async () => {
    const reader = await PackReader.open(memoryByteSource(await writePack([], { meta: META })))
    expect(reader.header.blockCount).toBe(0)
    expect(await reader.get('mouse')).toBeUndefined()
  })

  test('PackWriter streams blocks to its sink and hands back the parts around them', async () => {
    const chunks: Uint8Array[] = []
    const writer = new PackWriter({ meta: META, blockSize: 1024, write: chunk => { chunks.push(chunk) } })
    for (const record of manyRecords(500)) await writer.add(record)
    const { prefix, index, header } = await writer.finish()
    expect(chunks.length).toBe(header.blockCount)
    const bytes = Buffer.concat([prefix, ...chunks, index])
    expect(header.indexOffset).toBe(bytes.length - index.length)
    expect(await (await PackReader.open(memoryByteSource(bytes))).get('word00321')).toEqual(manyRecords(500)[321])
  })

  test('the writer refuses keys out of order, duplicate or empty keys, and use after finish', async () => {
    const writer = new PackWriter({ meta: META, write: () => {} })
    await writer.add({ k: 'b', e: [] })
    await expect(writer.add({ k: 'a', e: [] })).rejects.toThrow(/order/)
    await expect(writer.add({ k: 'b', e: [] })).rejects.toThrow(/order/)
    await writer.finish()
    await expect(writer.add({ k: 'c', e: [] })).rejects.toThrow(/finished/)
    await expect(writer.finish()).rejects.toThrow(/finished/)
    await expect(new PackWriter({ meta: META, write: () => {} }).add({ k: '', e: [] })).rejects.toThrow(/empty/)
  })

  test('keeps recent blocks in memory and reads each block once while cached', async () => {
    const records = manyRecords(3000)
    const bytes = await writePack(records, { meta: META, blockSize: 2048 })
    const { index } = parsePack(bytes)
    const firstAndSecond = (block: number) => {
      const at = records.findIndex(r => r.k === index[block]!.firstKey)
      return [records[at]!.k, records[at + 1]!.k] as const
    }
    const source = countingSource(bytes)
    const reader = await PackReader.open(source, { cacheBlocks: 2 })
    const opened = source.reads.length
    const [a1, a2] = firstAndSecond(0), [b1, b2] = firstAndSecond(20), [c1] = firstAndSecond(40)
    await reader.get(a1)
    await reader.get(a2)
    expect(source.reads.length).toBe(opened + 1)
    await Promise.all([reader.get(b1), reader.get(b2)])
    expect(source.reads.length).toBe(opened + 2)
    await reader.get(a1) // still cached; now the most recent
    await reader.get(c1) // evicts block 20
    await reader.get(a2)
    expect(source.reads.length).toBe(opened + 3)
    await reader.get(b1)
    expect(source.reads.length).toBe(opened + 4)
  })

  test('reads the header and index with few reads', async () => {
    const source = countingSource(await writePack(manyRecords(100), { meta: META }))
    await PackReader.open(source)
    expect(source.reads.length).toBeLessThanOrEqual(3)
  })
})

describe('PackReader errors', () => {
  let packBytes: Uint8Array
  const pack = async () => (packBytes ??= await writePack(manyRecords(800), { meta: META, blockSize: 2048 }))

  test('PACK_INVALID for a file too short or with the wrong magic', async () => {
    await expectCode(PackReader.open(memoryByteSource(new Uint8Array(5))), 'PACK_INVALID')
    const bytes = (await pack()).slice()
    bytes[0] = 0x58
    await expectCode(PackReader.open(memoryByteSource(bytes)), 'PACK_INVALID')
  })

  test('PACK_UNSUPPORTED_VERSION for another format version', async () => {
    const bytes = (await pack()).slice()
    view(bytes).setUint32(4, 2, true)
    await expectCode(PackReader.open(memoryByteSource(bytes)), 'PACK_UNSUPPORTED_VERSION')
  })

  test('PACK_CORRUPT for a truncated file', async () => {
    const bytes = await pack()
    await expectCode(PackReader.open(memoryByteSource(bytes.subarray(0, bytes.length - 10))), 'PACK_CORRUPT')
    await expectCode(PackReader.open(memoryByteSource(bytes.subarray(0, 40))), 'PACK_CORRUPT')
  })

  test('PACK_CORRUPT for a header that is not JSON or not a v1 header', async () => {
    const bytes = await pack()
    await expectCode(PackReader.open(memoryByteSource(withHeader(bytes, () => '{"version":'))), 'PACK_CORRUPT')
    await expectCode(PackReader.open(memoryByteSource(withHeader(bytes, () => '[]'))), 'PACK_CORRUPT')
    await expectCode(PackReader.open(memoryByteSource(withHeader(bytes, h => ({ ...h, version: 3 })))), 'PACK_CORRUPT')
    await expectCode(PackReader.open(memoryByteSource(withHeader(bytes, h => ({ ...h, blockCount: -1 })))), 'PACK_CORRUPT')
    await expectCode(PackReader.open(memoryByteSource(withHeader(bytes, h => ({ ...h, indexOffset: 'x' })))), 'PACK_CORRUPT')
    const invalidUtf8 = withHeader(bytes, h => JSON.stringify(h))
    invalidUtf8[PREAMBLE_BYTES + 2] = 0xff
    await expectCode(PackReader.open(memoryByteSource(invalidUtf8)), 'PACK_CORRUPT')
  })

  test('PACK_CORRUPT for an index that does not inflate, parse or match the blocks', async () => {
    const bytes = await pack()
    const { index } = parsePack(bytes)
    const encode = (value: unknown) => new Uint8Array(gzipSync(JSON.stringify(value)))
    const cases: Uint8Array[] = [
      new TextEncoder().encode('not gzip at all'),
      new Uint8Array(gzipSync('not json')),
      encode({ firstKey: 'a' }),
      encode(index.slice(1)),
      encode(index.map((item, i) => (i === 1 ? { ...item, offset: item.offset + 1 } : item))),
      encode(index.map((item, i) => (i === 2 ? { ...item, firstKey: 'a' } : item))),
      encode(index.map((item, i) => (i === 0 ? { ...item, length: 'x' } : item))),
      encode(index.map((item, i) => (i === index.length - 1 ? { ...item, length: item.length - 1 } : item))),
    ]
    for (const raw of cases) await expectCode(PackReader.open(memoryByteSource(withIndex(bytes, raw))), 'PACK_CORRUPT')
  })

  test('PACK_CORRUPT for a block that does not inflate or holds bad records; other blocks still work', async () => {
    const bytes = await pack()
    const { index } = parsePack(bytes)
    const block = index[3]!
    const damaged = bytes.slice()
    damaged[block.offset + Math.floor(block.length / 2)]! ^= 0xff
    const reader = await PackReader.open(memoryByteSource(damaged))
    await expectCode(reader.get(block.firstKey), 'PACK_CORRUPT')
    await expectCode(reader.get(block.firstKey), 'PACK_CORRUPT') // a failure is not cached
    expect(await reader.get(index[0]!.firstKey)).toBeDefined()
  })

  test('PACK_CORRUPT for a block whose records are not JSON, out of order or not records', async () => {
    const base = await pack()
    const { index } = parsePack(base)
    const replaceBlock = (text: string): Uint8Array => {
      // Rebuild the pack with block 0 replaced by `text`, keeping the rest.
      const block = new Uint8Array(gzipSync(text))
      const first = index[0]!
      const delta = block.length - first.length
      const items = index.map((item, i) => (i === 0 ? { ...item, length: block.length } : { ...item, offset: item.offset + delta }))
      const { header } = parsePack(base)
      const body = new Uint8Array(header.indexOffset + delta)
      body.set(base.subarray(0, first.offset))
      body.set(block, first.offset)
      body.set(base.subarray(first.offset + first.length, header.indexOffset), first.offset + block.length)
      const indexBytes = new Uint8Array(gzipSync(JSON.stringify(items)))
      const all = new Uint8Array(body.length + indexBytes.length)
      all.set(body)
      all.set(indexBytes, body.length)
      return withHeader(all, h => ({ ...h, indexOffset: body.length, indexLength: indexBytes.length }))
    }
    const key = index[0]!.firstKey
    for (const text of [`{"k":"${key}","e":[]}\nnot json\n`, `{"k":"${key}","e":[]}\n{"k":"a","e":[]}\n`, `{"k":"${key}"}\n`, `{"k":"other","e":[]}\n`, `[1]\n`]) {
      const reader = await PackReader.open(memoryByteSource(replaceBlock(text)))
      await expectCode(reader.get(key), 'PACK_CORRUPT')
    }
  })

  test('a read error from the source is PACK_READ_FAILED and is not cached', async () => {
    const bytes = await pack()
    const inner = memoryByteSource(bytes)
    let fail = false
    const source: ByteSource = { size: inner.size, read: (s, e) => (fail ? Promise.reject(new Error('gone')) : inner.read(s, e)) }
    const reader = await PackReader.open(source)
    fail = true
    await expectCode(reader.get('word00001'), 'PACK_READ_FAILED')
    fail = false
    expect(await reader.get('word00001')).toBeDefined()
  })

  test('memoryByteSource checks its range', async () => {
    const source = memoryByteSource(new Uint8Array([1, 2, 3]))
    expect([...await source.read(1, 3)]).toEqual([2, 3])
    await expect(source.read(2, 5)).rejects.toThrow(RangeError)
    await expect(source.read(-1, 1)).rejects.toThrow(RangeError)
  })
})
