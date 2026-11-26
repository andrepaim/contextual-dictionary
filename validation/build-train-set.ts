// Labelled training and development items from English Wiktionary examples (training round 1, docs/validation.md).
// Built like build-wiktionary-set.ts (same record filter, judgeExample, selectionAt, real pack lookup,
// variantRequest = the extension's senseRequest), but with every usable example (at most --per-entry per
// entry, seeded), only the variants 24|c1600 and 127, and these exclusions (validation/training-items.ts):
//   - headwords of data/wiktionary-items.tsv (first column) and lemmas of data/written-labels.tsv are skipped;
//   - an item whose lookup result contains an entry of a held-out lemma is dropped;
//   - an item whose passage equals a test passage of the three evaluation sets after normalisation, or shares
//     ten consecutive words with one, is dropped (the same quotation is often filed under several headwords);
//   - an identifier seen twice (the same example under the same meaning) is kept once.
// Split: development when sha256(`${seed}\n${headword}`) falls in the first --dev-share of the hash space.
// Writes under CD_TRAIN_OUT (default ~/.cache/contextual-dictionary/validation/train/data) only:
// train-items.jsonl, dev-items.jsonl (analyze.ts item format), train-prompts.jsonl, dev-prompts.jsonl, build.json.
// Contains Wiktionary text: never committed. The test items are read from --test-items (the evaluation builders' output).
//
//   npx tsx validation/build-train-set.ts [--seed cd-train-r1] [--dev-share 0.04] [--per-entry 12]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createGunzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { openWiktionaryDictionary } from '@andrepaim/contextual-dictionary-core'
import { ENTRY_BUCKETS, PATHS, VARIANTS, bucketLabel, bucketOf, fileSource, readFormat, readJsonl, selectionAt, sha256Hex, tokenCounter, variantRequest } from './common'
import { heldOutHeadwords, isDevelopmentHeadword, overlapsTestPassage, testPassageIndex } from './training-items'
import { judgeExample, keptSenses } from './wiktionary-items'

const { values } = parseArgs({ options: {
  seed: { type: 'string', default: 'cd-train-r1' },
  'dev-share': { type: 'string', default: '0.04' },
  'per-entry': { type: 'string', default: '12' },
  'test-items': { type: 'string', default: path.join(os.homedir(), '.cache/contextual-dictionary/validation') },
} })
const SEED = values.seed!, DEV_SHARE = Number(values['dev-share']), PER_ENTRY = Number(values['per-entry'])
const KEYS = ['24|c1600', '127']
const variants = VARIANTS.filter(v => KEYS.includes(v.key))

const data = (name: string) => fs.readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const HELD_OUT = heldOutHeadwords(data('wiktionary-items.tsv'), data('written-labels.tsv'))
const isDev = (word: string) => isDevelopmentHeadword(word, SEED, DEV_SHARE)
type TestItem = { selection: { before?: string; text: string; after?: string } }
const passageOf = (selection: TestItem['selection']) => (selection.before ?? '') + selection.text + (selection.after ?? '')
const TESTS = testPassageIndex(['wiktionary', 'written', 'simple'].flatMap(set => readJsonl<TestItem>(path.join(values['test-items']!, `${set}-items.jsonl`)).map(item => passageOf(item.selection))))
if (!TESTS.passages.size) throw new Error(`no test items under ${values['test-items']}: run the evaluation builders first`)

/** Outputs hold Wiktionary or Wikipedia text: under ~/.cache, never in the repository. */
const OUT = process.env.CD_TRAIN_OUT ?? path.join(PATHS.out, 'train', 'data')
fs.mkdirSync(OUT, { recursive: true })
const counts: Record<string, number> = {}
const count = (key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by }

interface Candidate { word: string; pos: string; line: number; packSense: number; meanings: number; definition: string; definitions: string[]; exampleHash: string; exampleType: string; year?: number; text: string; start: number; end: number; rank: string }
const candidates: Candidate[] = []

const input = fs.createReadStream(PATHS.kaikki).pipe(createGunzip())
const lines = readline.createInterface({ input, crlfDelay: Infinity })
let line = 0
for await (const text of lines) {
  line++
  if (line % 500_000 === 0) console.error(`${line} lines, ${candidates.length} examples`)
  if (!text.includes('"examples"')) continue
  const record = JSON.parse(text)
  if (record.lang_code !== 'en' || typeof record.word !== 'string' || typeof record.pos !== 'string') continue
  if (['name', 'character', 'symbol', 'punct'].includes(record.pos)) continue
  const word: string = record.word
  if (!/^[a-z]{2,}$/u.test(word)) continue
  const senses = keptSenses(record.senses)
  if (senses.length < 2) continue
  if (HELD_OUT.has(word)) { count('entries skipped: held-out headword'); count(`held-out entries, stratum ${bucketLabel(bucketOf(ENTRY_BUCKETS, senses.length)!)}`); continue }
  count('entries with two or more meanings and an example')
  const forms = new Set<string>((Array.isArray(record.forms) ? record.forms : []).map((form: { form?: unknown }) => typeof form.form === 'string' ? form.form.toLowerCase() : '').filter(Boolean))
  const definitions = senses.map(sense => sense.definition)
  const mine: Candidate[] = []
  senses.forEach((sense, packSense) => {
    for (const example of sense.examples) {
      const verdict = judgeExample(example, word, forms)
      count(verdict.ok ? 'examples usable' : `examples skipped: ${verdict.reason}`)
      if (!verdict.ok) continue
      const exampleText = example.text as string
      const exampleHash = sha256Hex(exampleText).slice(0, 16)
      const type = example.type === 'quotation' || (example.type !== 'example' && example.ref !== undefined) ? 'quotation' : 'example'
      mine.push({ rank: sha256Hex(`${SEED}\n${word}\n${record.pos}\n${packSense}\n${exampleHash}`), word, pos: record.pos, line, packSense, meanings: senses.length, definition: sense.definition, definitions, exampleHash, exampleType: type, text: exampleText, start: verdict.start, end: verdict.end, ...(verdict.year === undefined ? {} : { year: verdict.year }) })
    }
  })
  if (!mine.length) continue
  count('entries with a usable example')
  count(`entries with a usable example, stratum ${bucketLabel(bucketOf(ENTRY_BUCKETS, senses.length)!)}`)
  mine.sort((a, b) => (a.rank < b.rank ? -1 : 1))
  if (mine.length > PER_ENTRY) count('examples dropped: over the per-entry limit', mine.length - PER_ENTRY)
  candidates.push(...mine.slice(0, PER_ENTRY))
}
console.error(`read ${line} lines; ${candidates.length} examples kept`)

const format = readFormat()
const tokens = tokenCounter()
const source = await fileSource(PATHS.pack)
const dictionary = await openWiktionaryDictionary(source)
const out = { train: { items: [] as string[], prompts: new Map<string, string>() }, dev: { items: [] as string[], prompts: new Map<string, string>() } }
let done = 0
const seenIds = new Set<string>()
for (const c of candidates) {
  if (++done % 20_000 === 0) console.error(`${done}/${candidates.length} looked up`)
  const selection = selectionAt(c.text, c.start, c.end)
  const result = await dictionary.define(selection)
  const entry = result.entries.findIndex(item => item.lemma === c.word && item.partOfSpeech === c.pos
    && item.senses.length === c.definitions.length && item.senses.every((sense, i) => sense.definition === c.definitions[i]))
  if (entry < 0) { count(result.entries.some(item => item.lemma === c.word && item.partOfSpeech === c.pos) ? 'excluded: entry differs in the pack' : 'excluded: entry not in the lookup result'); continue }
  if (c.definitions.filter(d => d === c.definition).length > 1) { count('excluded: labelled definition repeated in its entry'); continue }
  if (result.entries.some(item => HELD_OUT.has(item.lemma))) { count('excluded: lookup returns a held-out lemma'); continue }
  if (overlapsTestPassage(passageOf(selection), TESTS)) { count('excluded: passage equals or overlaps a test passage'); continue }
  const id = `${c.word}|${c.pos}|${c.packSense}|${c.exampleHash}`
  if (seenIds.has(id)) { count('excluded: identifier seen before (same example, same meaning)'); continue }
  seenIds.add(id)
  const split = isDev(c.word) ? out.dev : out.train
  const perCap: Record<string, unknown> = {}
  for (const variant of variants) {
    const request = variantRequest(result, selection, format, variant)
    if ('skip' in request) { perCap[variant.key] = { skip: request.skip }; continue }
    const hash = sha256Hex(request.prompt)
    if (!split.prompts.has(hash)) split.prompts.set(hash, JSON.stringify({ hash, prompt: request.prompt, tokens: tokens(request.prompt), offered: request.candidates.length, target: request.target }))
    perCap[variant.key] = { prompt: hash, candidates: request.candidates.map(x => [x.entry, x.sense]), labelledOffered: request.candidates.some(x => x.entry === entry && x.sense === c.packSense) }
  }
  split.items.push(JSON.stringify({
    id, word: c.word, pos: c.pos, stratum: bucketLabel(bucketOf(ENTRY_BUCKETS, c.meanings)!), meanings: c.meanings,
    kaikkiLine: c.line, exampleType: c.exampleType, year: c.year ?? null, selection, labelled: { entry, sense: c.packSense },
    entrySenses: result.entries.map(item => item.senses.length), total: result.entries.reduce((sum, item) => sum + item.senses.length, 0), perCap,
  }))
  count(`items ${split === out.dev ? 'dev' : 'train'}`)
}
await source.close()
for (const name of ['train', 'dev'] as const) {
  fs.writeFileSync(path.join(OUT, `${name}-items.jsonl`), out[name].items.join('\n') + '\n')
  fs.writeFileSync(path.join(OUT, `${name}-prompts.jsonl`), [...out[name].prompts.values()].join('\n') + '\n')
}
const report = { seed: SEED, devShare: DEV_SHARE, perEntry: PER_ENTRY, kaikki: PATHS.kaikki, pack: PATHS.pack, heldOut: HELD_OUT.size, train: out.train.items.length, dev: out.dev.items.length, trainPrompts: out.train.prompts.size, devPrompts: out.dev.prompts.size, counts }
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
