// Builds the Wiktionary-derived evaluation set (docs/validation.md, "Accuracy").
//
//   npx tsx validation/build-wiktionary-set.ts [--seed cd-validation-v1] [--per-stratum 450]
//
// Every usage example and quotation in the Kaikki extract is attached by
// Wiktionary's editors to the meaning it illustrates; that attachment is the
// label. For single-word, lower-case headwords whose entry (one part of
// speech) keeps at least two meanings in the pack, one example per entry is
// drawn (seeded hash), then up to --per-stratum entries per stratum of
// meanings in the entry (2, 3–4, 5–8, 9–16, 17–32, 33+). The headword's
// occurrence becomes the selection, the context is cut to 120 characters
// each side, and the word is looked up in the real pack with the extension's
// own lookup. An item whose labelled meaning is not found in the looked-up
// entry is excluded and counted.
//
// Writes, under ~/.cache/contextual-dictionary/validation/:
//   wiktionary-items.jsonl   items with selection, labelled meaning and the prompt per cap (not committed: contains Wiktionary text)
//   prompts.jsonl            each distinct prompt once, with its token count
//   wiktionary-build.json    counts: candidates, exclusions, leakage check
// and validation/data/wiktionary-items.tsv, the committed item identifiers.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createGunzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { openWiktionaryDictionary } from '../src/dict/lookup'
import { ENTRY_BUCKETS, VARIANTS, variantRequest, PATHS, bucketLabel, bucketOf, fileSource, readFormat, selectionAt, sha256Hex, tokenCounter } from './common'
import { judgeExample, keptSenses } from './wiktionary-items'

const { values } = parseArgs({ options: { seed: { type: 'string', default: 'cd-validation-v1' }, 'per-stratum': { type: 'string', default: '450' } } })
const SEED = values.seed!
const PER_STRATUM = Number(values['per-stratum'])

interface Candidate {
  rank: string
  word: string
  pos: string
  line: number
  kaikkiSense: number
  packSense: number
  meanings: number
  definition: string
  definitions: string[]
  exampleHash: string
  exampleType: string
  year?: number
  text: string
  start: number
  end: number
}

const counts: Record<string, number> = {}
const count = (key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by }
const strata = new Map<string, Candidate[]>(ENTRY_BUCKETS.map(bucket => [bucketLabel(bucket), []]))
const prune = (list: Candidate[]) => { list.sort((a, b) => (a.rank < b.rank ? -1 : 1)); list.length = Math.min(list.length, PER_STRATUM) }

const input = fs.createReadStream(PATHS.kaikki).pipe(createGunzip())
const lines = readline.createInterface({ input, crlfDelay: Infinity })
let line = 0
const started = Date.now()
for await (const text of lines) {
  line++
  if (line % 200_000 === 0) console.error(`${line} lines, ${((Date.now() - started) / 1000).toFixed(0)} s`)
  if (!text.includes('"examples"')) continue
  const record = JSON.parse(text)
  if (record.lang_code !== 'en' || typeof record.word !== 'string' || typeof record.pos !== 'string') continue
  if (['name', 'character', 'symbol', 'punct'].includes(record.pos)) continue
  const word: string = record.word
  if (!/^[a-z]{2,}$/u.test(word)) continue
  const senses = keptSenses(record.senses)
  if (senses.length < 2) continue
  count('entries with two or more meanings and an example')
  const forms = new Set<string>((Array.isArray(record.forms) ? record.forms : []).map((form: { form?: unknown }) => typeof form.form === 'string' ? form.form.toLowerCase() : '').filter(Boolean))
  const definitions = senses.map(sense => sense.definition)
  let best: Candidate | undefined
  senses.forEach((sense, packSense) => {
    for (const example of sense.examples) {
      const verdict = judgeExample(example, word, forms)
      count(verdict.ok ? 'examples usable' : `examples skipped: ${verdict.reason}`)
      if (!verdict.ok) continue
      const exampleText = example.text as string
      const exampleHash = sha256Hex(exampleText).slice(0, 16)
      const rank = sha256Hex(`${SEED}\n${word}\n${record.pos}\n${packSense}\n${exampleHash}`)
      if (best && best.rank <= rank) continue
      const type = example.type === 'quotation' || (example.type !== 'example' && example.ref !== undefined) ? 'quotation' : 'example'
      best = {
        rank, word, pos: record.pos, line, kaikkiSense: sense.kaikkiIndex, packSense, meanings: senses.length,
        definition: sense.definition, definitions, exampleHash, exampleType: type, text: exampleText, start: verdict.start, end: verdict.end,
        ...(verdict.year === undefined ? {} : { year: verdict.year }),
      }
    }
  })
  if (!best) continue
  count('entries with a usable example')
  const list = strata.get(bucketLabel(bucketOf(ENTRY_BUCKETS, senses.length)!))!
  list.push(best)
  count(`entries with a usable example, stratum ${bucketLabel(bucketOf(ENTRY_BUCKETS, senses.length)!)}`)
  if (list.length > PER_STRATUM * 4) prune(list)
}
for (const list of strata.values()) prune(list)
console.error(`read ${line} lines in ${((Date.now() - started) / 1000).toFixed(0)} s`)

// ------------------------------------------------------------ lookups and prompts

const format = readFormat()
const tokens = tokenCounter()
const source = await fileSource(PATHS.pack)
const dictionary = await openWiktionaryDictionary(source)
const prompts = new Map<string, { hash: string; prompt: string; tokens: number; offered: number }>()
const items: unknown[] = []
const tsv: string[] = ['word\tpos\tmeaning\texample_sha256_16\tstratum']
let leaks = 0

for (const [stratum, list] of strata) {
  for (const candidate of list.sort((a, b) => (a.rank < b.rank ? -1 : 1))) {
    const selection = selectionAt(candidate.text, candidate.start, candidate.end)
    const result = await dictionary.define(selection)
    // The labelled entry: same headword and part of speech, the same meanings in the same order.
    const entry = result.entries.findIndex(item => item.lemma === candidate.word && item.partOfSpeech === candidate.pos
      && item.senses.length === candidate.definitions.length && item.senses.every((sense, i) => sense.definition === candidate.definitions[i]))
    if (entry < 0) {
      const near = result.entries.some(item => item.lemma === candidate.word && item.partOfSpeech === candidate.pos)
      count(near ? 'excluded: entry differs in the pack' : 'excluded: entry not in the lookup result')
      continue
    }
    if (candidate.definitions.filter(definition => definition === candidate.definition).length > 1) { count('excluded: labelled definition repeated in its entry'); continue }
    const perCap: Record<string, unknown> = {}
    for (const variant of VARIANTS) {
      const cap = variant.key
      const request = variantRequest(result, selection, format, variant)
      if ('skip' in request) { perCap[cap] = { skip: request.skip }; continue }
      const hash = sha256Hex(request.prompt)
      if (!prompts.has(hash)) prompts.set(hash, { hash, prompt: request.prompt, tokens: tokens(request.prompt), offered: request.candidates.length })
      // No leakage: the prompt holds definitions only, never an example of any meaning offered.
      const examples = result.entries.flatMap(item => item.senses.flatMap(sense => sense.examples))
      // The first line is the passage itself; the choices follow it.
      const choices = request.prompt.slice(request.prompt.indexOf('\n') + 1)
      if (choices.includes(candidate.text.trim().slice(0, 40)) || examples.some(example => example.length >= 20 && choices.includes(example))) leaks++
      const labelledOffered = request.candidates.some(c => c.entry === entry && c.sense === candidate.packSense)
      perCap[cap] = { prompt: hash, candidates: request.candidates.map(c => [c.entry, c.sense]), labelledOffered }
    }
    items.push({
      id: `${candidate.word}|${candidate.pos}|${candidate.packSense}|${candidate.exampleHash}`,
      word: candidate.word, pos: candidate.pos, stratum, meanings: candidate.meanings, kaikkiLine: candidate.line, kaikkiSense: candidate.kaikkiSense,
      exampleType: candidate.exampleType, year: candidate.year ?? null,
      selection, labelled: { entry, sense: candidate.packSense },
      entrySenses: result.entries.map(item => item.senses.length), total: result.entries.reduce((sum, item) => sum + item.senses.length, 0),
      perCap,
    })
    tsv.push([candidate.word, candidate.pos, candidate.packSense, candidate.exampleHash, stratum].join('\t'))
    count(`items, stratum ${stratum}`)
  }
}
await source.close()

fs.writeFileSync(path.join(PATHS.out, 'wiktionary-items.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n')
const existing = new Map<string, unknown>()
const promptFile = path.join(PATHS.out, 'prompts.jsonl')
if (fs.existsSync(promptFile)) for (const lineText of fs.readFileSync(promptFile, 'utf8').split('\n').filter(Boolean)) { const p = JSON.parse(lineText); existing.set(p.hash, p) }
for (const [hash, prompt] of prompts) existing.set(hash, prompt)
fs.writeFileSync(promptFile, [...existing.values()].map(item => JSON.stringify(item)).join('\n') + '\n')
fs.writeFileSync(new URL('./data/wiktionary-items.tsv', import.meta.url), tsv.join('\n') + '\n')
const report = { seed: SEED, perStratum: PER_STRATUM, kaikki: PATHS.kaikki, items: items.length, prompts: prompts.size, leaks, counts }
fs.writeFileSync(path.join(PATHS.out, 'wiktionary-build.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
