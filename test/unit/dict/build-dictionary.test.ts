import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { buildDictionary, externalSort, main, parseArguments, percentile, type SortItem } from '../../../scripts/build-dictionary'
import { memoryByteSource, PackReader } from '../../../src/dict/pack-reader'
import { openWiktionaryDictionary } from '../../../src/dict/lookup'

const FIXTURE = fileURLToPath(new URL('../../fixtures/dict/kaikki-extract.ndjson', import.meta.url))

let dir: string
let gzInput: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-build-test-'))
  gzInput = path.join(dir, 'english-2026-10-30.jsonl.gz')
  fs.writeFileSync(gzInput, gzipSync(fs.readFileSync(FIXTURE)))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const open = async (file: string) => PackReader.open(memoryByteSource(new Uint8Array(fs.readFileSync(file))))

describe('buildDictionary', () => {
  test('builds a pack from a gzipped extract and writes stats', async () => {
    const output = path.join(dir, 'a.pack')
    const statsPath = path.join(dir, 'a-stats.json')
    const stats = await buildDictionary({ input: gzInput, output, statsPath, snapshot: '2026-10-30' })
    expect(fs.existsSync(output)).toBe(true)
    expect(JSON.parse(fs.readFileSync(statsPath, 'utf8'))).toEqual(stats)
    expect(stats.pack).toEqual({ bytes: fs.statSync(output).size, sha256: sha256(output), blocks: expect.any(Number), indexBytes: expect.any(Number) })
    expect(stats.input).toEqual({ file: 'english-2026-10-30.jsonl.gz', sha256: sha256(gzInput), lines: 63, records: 62 })
    expect(stats.skipped).toEqual({ 'excluded-pos': 5, 'no-letter': 2, 'not-english': 1, 'no-word': 1, 'no-senses': 1 })
    expect(stats.excludedByPos).toEqual({ name: 2, character: 1, symbol: 1, punct: 1 })
    expect(stats.droppedSenses).toBe(5)
    expect(stats.cleanedGlosses).toBe(4)
    expect(stats.entries).toBe(52)
    expect(stats.keys).toBe(40)
    expect(stats.meanings).toBe(53)
    expect(stats.pointers).toBe(13)
    expect(stats.largestKeys[0]).toEqual({ key: 'markup', meanings: 5 })
    expect(stats.largestKeys.length).toBeLessThanOrEqual(20)
    expect(stats.meaningsPerKey).toEqual({ keysWithMeanings: expect.any(Number), p50: expect.any(Number), p90: expect.any(Number), p99: 5, p999: 5, max: 5 })
    expect(stats.options).toMatchObject({ maxExamples: 2, maxExampleChars: 240, labels: true, excludedPos: ['name', 'character', 'symbol', 'punct'] })

    const reader = await open(output)
    expect(reader.header).toMatchObject({ language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', snapshot: '2026-10-30', keyCount: stats.keys, entryCount: stats.entries, senseCount: stats.meanings, pointerCount: stats.pointers })
    expect(reader.header.createdFrom).toBe(`english-2026-10-30.jsonl.gz sha256:${sha256(gzInput)}`)
    expect(await reader.get('mice')).toEqual({ k: 'mice', e: [
      { w: 'mice', p: 'noun', f: [{ l: 'mouse', n: 'plural of mouse' }] },
      { w: 'mice', p: 'verb', s: ['(Bermuda) To be distracted or inattentive.'] },
    ] })
    // Several spellings under one key: by spelling, then in extract order.
    expect((await reader.get('mouse'))!.e.map(e => `${e.w}/${e.p}`)).toEqual(['MOUSE/noun', 'mouse/noun', 'mouse/verb'])
    expect((await reader.get('bank'))!.e.map(e => `${e.p}: ${String(e.s![0])}`)).toEqual([
      'noun: An institution where one can place and borrow money.,She works at a bank.',
      'verb: To deposit in a bank.',
      'noun: A row or panel of items, such as keys or switches.',
    ])
    expect((await reader.get('polish'))!.e.map(e => `${e.w}/${e.p}`)).toEqual(['Polish/adj', 'polish/verb', 'polish/noun'])
    for (const missing of ['smith', 'haus', '&', '42', '!', 'emptyword']) expect(await reader.get(missing), missing).toBeUndefined()
    expect((await reader.get('a'))!.e.map(e => e.p)).toEqual(['article'])
  })

  test('the pack serves lookups', async () => {
    const output = path.join(dir, 'lookup.pack')
    await buildDictionary({ input: gzInput, output })
    const dictionary = await openWiktionaryDictionary(memoryByteSource(new Uint8Array(fs.readFileSync(output))))
    const mice = await dictionary.define({ text: 'mice', before: 'Three ', after: ' ran.' })
    expect(mice.entries.map(e => [e.lemma, e.partOfSpeech, e.note])).toEqual([['mouse', 'noun', 'plural of mouse'], ['mice', 'verb', undefined]])
    const network = await dictionary.define({ text: 'network', before: 'a neural ', after: '' })
    expect(network.entries.map(e => e.lemma)).toEqual(['neural network', 'network'])
  })

  test('the same input gives a byte-identical pack, however the sort is split', async () => {
    const one = path.join(dir, 'one.pack'), two = path.join(dir, 'two.pack'), three = path.join(dir, 'three.pack')
    await buildDictionary({ input: gzInput, output: one })
    await buildDictionary({ input: gzInput, output: two, sortChunkBytes: 300, tempDir: dir })
    await buildDictionary({ input: gzInput, output: three, sortChunkBytes: 1 })
    expect(sha256(two)).toBe(sha256(one))
    expect(sha256(three)).toBe(sha256(one))
    expect(fs.readdirSync(dir).filter(name => name.startsWith('cd-sort-'))).toEqual([])
  })

  test('reads an uncompressed extract too, and honours scope and block options', async () => {
    const output = path.join(dir, 'plain.pack')
    const stats = await buildDictionary({ input: FIXTURE, output, blockSize: 256, compressionLevel: 1, scope: { maxExamples: 0, labels: false } })
    const reader = await open(output)
    expect(reader.header.blockCount).toBeGreaterThan(3)
    expect(reader.header.snapshot).toBe('unknown')
    expect(stats.examples).toBe(0)
    expect(await reader.get('mouse')).toMatchObject({ e: [{ w: 'MOUSE' }, { w: 'mouse', s: ['Any small rodent of the genus Mus.', 'A computer input device that is moved over a pad or other flat surface to produce a corresponding movement of a pointer on a graphical display.'] }, { w: 'mouse' }] })
  })

  test('takes the snapshot date from the file name when not given', async () => {
    const output = path.join(dir, 'dated.pack')
    await buildDictionary({ input: gzInput, output })
    expect((await open(output)).header.snapshot).toBe('2026-10-30')
  })

  test('a line that is not JSON stops the build with its line number, leaving no output', async () => {
    const bad = path.join(dir, 'bad.ndjson')
    fs.writeFileSync(bad, '{"word":"a","pos":"noun","senses":[{"glosses":["x"]}]}\n{not json\n')
    const output = path.join(dir, 'bad.pack')
    await expect(buildDictionary({ input: bad, output })).rejects.toThrow(/line 2/)
    expect(fs.existsSync(output)).toBe(false)
    expect(fs.readdirSync(dir).filter(name => name.startsWith('bad.pack'))).toEqual([])
  })
})

describe('externalSort', () => {
  const item = (key: string, w: string, seq: number): SortItem => ({ key, w, seq, entry: { w, p: 'noun', s: [`${key} ${seq}`] } })
  async function* items(list: SortItem[]) { yield* list }
  async function collect(source: AsyncIterable<SortItem>) { const out: SortItem[] = []; for await (const value of source) out.push(value); return out }

  test('orders by key, then spelling, then sequence, in memory and through files', async () => {
    const list = [item('b', 'b', 1), item('a', 'a', 2), item('b', 'B', 3), item('a', 'a', 0), item('c', 'c', 4), item('b', 'B', 5)]
    const expected = ['a/a/0', 'a/a/2', 'b/B/3', 'b/B/5', 'b/b/1', 'c/c/4']
    const name = (value: SortItem) => `${value.key}/${value.w}/${value.seq}`
    expect((await collect(externalSort(items(list), { chunkBytes: 1 << 20, tempDir: dir }))).map(name)).toEqual(expected)
    const spilled = await collect(externalSort(items(list), { chunkBytes: 10, tempDir: dir }))
    expect(spilled.map(name)).toEqual(expected)
    expect(spilled[0]!.entry).toEqual({ w: 'a', p: 'noun', s: ['a 0'] })
    expect(await collect(externalSort(items([]), { chunkBytes: 10, tempDir: dir }))).toEqual([])
    expect(fs.readdirSync(dir).filter(n => n.startsWith('cd-sort-'))).toEqual([])
  })

  test('removes its files when the consumer stops early', async () => {
    const list = Array.from({ length: 50 }, (_, i) => item(`k${i}`, 'w', i))
    for await (const value of externalSort(items(list), { chunkBytes: 50, tempDir: dir })) { expect(value.key).toBe('k0'); break }
    expect(fs.readdirSync(dir).filter(n => n.startsWith('cd-sort-'))).toEqual([])
  })
})

describe('percentile', () => {
  test('nearest rank over a histogram', () => {
    const histogram = new Map([[1, 90], [2, 9], [10, 1]])
    expect(percentile(histogram, 0.5)).toBe(1)
    expect(percentile(histogram, 0.9)).toBe(1)
    expect(percentile(histogram, 0.95)).toBe(2)
    expect(percentile(histogram, 0.999)).toBe(10)
    expect(percentile(new Map(), 0.5)).toBe(0)
  })
})

describe('command line', () => {
  test('parseArguments reads the options', () => {
    expect(parseArguments(['--input', 'in.jsonl.gz', '--output', 'out.pack'])).toEqual({ input: 'in.jsonl.gz', output: 'out.pack', scope: {} })
    expect(parseArguments(['--input=in', '--output=out', '--stats=s.json', '--snapshot=2026-10-30', '--examples=1', '--example-chars=100', '--no-labels', '--block-size=1024', '--sort-chunk-mb=8', '--temp-dir=/tmp/x', '--level=6', '--include-pos=name', '--exclude-pos=suffix'])).toEqual({
      input: 'in', output: 'out', statsPath: 's.json', snapshot: '2026-10-30', blockSize: 1024, sortChunkBytes: 8 * 1024 * 1024, tempDir: '/tmp/x', compressionLevel: 6,
      scope: { maxExamples: 1, maxExampleChars: 100, labels: false, excludedPos: ['character', 'symbol', 'punct', 'suffix'] },
    })
  })

  test('parseArguments refuses missing or bad values', () => {
    expect(() => parseArguments(['--output', 'x'])).toThrow(/--input/)
    expect(() => parseArguments(['--input', 'x'])).toThrow(/--output/)
    expect(() => parseArguments(['--input', 'x', '--output', 'y', '--examples', 'many'])).toThrow(/--examples/)
    expect(() => parseArguments(['--input', 'x', '--output', 'y', '--level', '12'])).toThrow(/--level/)
    expect(() => parseArguments(['--input', 'x', '--output', 'y', '--bogus'])).toThrow()
  })

  test('main builds and prints a summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const output = path.join(dir, 'main.pack')
    await main(['--input', gzInput, '--output', output, '--stats', path.join(dir, 'main-stats.json')])
    expect(fs.existsSync(output)).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toMatch(/entries.*meanings.*pointers/s)
  })
})
