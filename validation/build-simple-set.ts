// Builds the evaluation set made from Simple English Wiktionary
// (docs/validation.md, "The Simple English Wiktionary set"): a second
// dictionary, with its own definitions and examples, whose editors also
// attach each example to the meaning it illustrates.
//
//   npx tsx validation/build-simple-set.ts [--seed cd-validation-v1]
//
// Entries are chosen as for the English set (build-wiktionary-set.ts): one
// lower-case word, at least two meanings in one part of speech, an example
// of at least six words that holds the word. An example that English
// Wiktionary also has for that word is left out, so the set stays apart from
// anything made of the English examples. One example per entry is drawn
// (seeded hash); every entry with one is an item.
//
// There is no pack of Simple English Wiktionary, so the meanings offered
// are built here with the pack's own rules: every entry of the spelling, in
// extract order (simpleResult). The definitions are Simple English
// Wiktionary's, not the ones the extension shows.
//
// Writes, under ~/.cache/contextual-dictionary/validation/:
//   simple-items.jsonl   items with selection, labelled meaning and the prompt per cap (not committed: contains Wiktionary text)
//   prompts.jsonl        adds each new distinct prompt, with its token count
//   simple-build.json    counts: candidates, exclusions, leakage check
// and validation/data/simple-items.tsv, the committed item identifiers.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createGunzip } from 'node:zlib'
import { parseArgs } from 'node:util'
import { DEFAULT_SCOPE, cleanMarkup } from '../src/dict/kaikki'
import { ENTRY_BUCKETS, PATHS, bucketLabel, bucketOf, readFormat, readJsonl, selectionAt, sha256Hex, tokenCounter, variantPrompts, type StoredPrompt } from './common'
import { normalizeExample, repeatsExample, simpleResult } from './simple-items'
import { judgeExample, keptSenses } from './wiktionary-items'

const { values } = parseArgs({ options: { seed: { type: 'string', default: 'cd-validation-v1' } } })
const SEED = values.seed!

interface Usable { sense: number; text: string; start: number; end: number; hash: string }
interface Entry { word: string; pos: string; line: number; record: unknown; definitions: string[]; usable: Usable[] }

const counts: Record<string, number> = {}
const count = (key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by }
const jsonLines = (file: string) => readline.createInterface({ input: fs.createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity })
const stratumOf = (meanings: number) => bucketLabel(bucketOf(ENTRY_BUCKETS, meanings)!)

// ------------------------------------------------- Simple English Wiktionary

const bySpelling = new Map<string, unknown[]>()
const entries: Entry[] = []
let line = 0
for await (const text of jsonLines(PATHS.simple)) {
  line++
  const record = JSON.parse(text)
  if (record.lang_code !== 'en' || typeof record.word !== 'string' || typeof record.pos !== 'string') continue
  const word: string = record.word
  bySpelling.set(word, [...(bySpelling.get(word) ?? []), record])
  if (DEFAULT_SCOPE.excludedPos.includes(record.pos) || !/^[a-z]{2,}$/u.test(word)) continue
  const senses = keptSenses(record.senses)
  if (senses.length < 2) continue
  count('entries with two or more meanings')
  count(`entries with two or more meanings, stratum ${stratumOf(senses.length)}`)
  const forms = new Set<string>((Array.isArray(record.forms) ? record.forms : []).map((form: { form?: unknown }) => typeof form.form === 'string' ? form.form.toLowerCase() : '').filter(Boolean))
  const usable: Usable[] = []
  senses.forEach((sense, index) => {
    for (const example of sense.examples) {
      const verdict = judgeExample(example, word, forms)
      count(verdict.ok ? 'examples long enough and holding the word' : `examples skipped: ${verdict.reason}`)
      if (verdict.ok) usable.push({ sense: index, text: example.text as string, start: verdict.start, end: verdict.end, hash: sha256Hex(example.text as string).slice(0, 16) })
    }
  })
  if (usable.length) entries.push({ word, pos: record.pos, line, record, definitions: senses.map(sense => sense.definition), usable })
}
console.error(`read ${line} lines of the Simple English extract`)

// ----------------------- what English Wiktionary has for the same headwords

const wanted = new Set(entries.map(entry => entry.word))
const englishExamples = new Map<string, Set<string>>(), englishGlosses = new Map<string, Set<string>>()
const add = (map: Map<string, Set<string>>, word: string, text: string) => { if (text) map.set(word, (map.get(word) ?? new Set()).add(text)) }
line = 0
const started = Date.now()
for await (const text of jsonLines(PATHS.kaikki)) {
  line++
  if (line % 200_000 === 0) console.error(`${line} lines, ${((Date.now() - started) / 1000).toFixed(0)} s`)
  const record = JSON.parse(text)
  if (record.lang_code !== 'en' || !wanted.has(record.word)) continue
  for (const sense of Array.isArray(record.senses) ? record.senses : []) {
    for (const gloss of Array.isArray(sense?.glosses) ? sense.glosses : []) if (typeof gloss === 'string') add(englishGlosses, record.word, normalizeExample(cleanMarkup(gloss)))
    for (const example of Array.isArray(sense?.examples) ? sense.examples : []) if (typeof example?.text === 'string') add(englishExamples, record.word, normalizeExample(example.text))
  }
}
console.error(`read ${line} lines of the English extract in ${((Date.now() - started) / 1000).toFixed(0)} s`)
count('headwords also in English Wiktionary', [...wanted].filter(word => englishGlosses.has(word)).length)

// ------------------------------------------------------- items and prompts

const format = readFormat()
const tokens = tokenCounter()
const prompts = new Map<string, StoredPrompt>()
const items: Array<{ id: string }> = []
const tsv: string[] = ['word\tpos\tmeaning\texample_sha256_16\tstratum']
let leaks = 0

for (const entry of entries) {
  const english = englishExamples.get(entry.word) ?? new Set<string>()
  let best: (Usable & { rank: string }) | undefined
  for (const example of entry.usable) {
    if (repeatsExample(example.text, english)) { count('examples skipped: also in English Wiktionary'); continue }
    count('examples usable')
    const rank = sha256Hex(`${SEED}\n${entry.word}\n${entry.pos}\n${example.sense}\n${example.hash}`)
    if (!best || rank < best.rank) best = { ...example, rank }
  }
  if (!best) { count('entries left without an example'); continue }
  const stratum = stratumOf(entry.definitions.length)
  count('entries with a usable example')
  const definition = entry.definitions[best.sense]!
  if (entry.definitions.filter(other => other === definition).length > 1) { count('excluded: labelled definition repeated in its entry'); continue }
  const records = bySpelling.get(entry.word)!
  const { result, entryOf } = simpleResult(entry.word, records)
  const labelled = { entry: entryOf[records.indexOf(entry.record)]!, sense: best.sense }
  const selection = selectionAt(best.text, best.start, best.end)
  // No leakage: the prompt holds definitions only, never an example of any meaning offered.
  const examples = result.entries.flatMap(item => item.senses.flatMap(sense => sense.examples))
  const perCap = variantPrompts(result, selection, labelled, format, tokens, prompts, request => {
    // The first line is the passage itself; the choices follow it.
    const choices = request.prompt.slice(request.prompt.indexOf('\n') + 1)
    if (choices.includes(best.text.trim().slice(0, 40)) || examples.some(example => example.length >= 20 && choices.includes(example))) leaks++
  })
  const definitionInEnglish = englishGlosses.get(entry.word)?.has(normalizeExample(definition)) ?? false
  if (definitionInEnglish) count('items whose labelled definition English Wiktionary also has')
  items.push({
    id: `${entry.word}|${entry.pos}|${best.sense}|${best.hash}`,
    word: entry.word, pos: entry.pos, stratum, meanings: entry.definitions.length, simpleLine: entry.line, definitionInEnglish,
    selection, labelled,
    entrySenses: result.entries.map(item => item.senses.length), total: result.entries.reduce((sum, item) => sum + item.senses.length, 0),
    perCap,
  } as { id: string })
  tsv.push([entry.word, entry.pos, best.sense, best.hash, stratum].join('\t'))
  count(`items, stratum ${stratum}`)
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
items.sort((a, b) => order(a.id, b.id))
fs.writeFileSync(path.join(PATHS.out, 'simple-items.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n')
const promptFile = path.join(PATHS.out, 'prompts.jsonl')
const stored = new Map(readJsonl<StoredPrompt>(promptFile).map(prompt => [prompt.hash, prompt]))
const added = [...prompts.keys()].filter(hash => !stored.has(hash)).length
for (const [hash, prompt] of prompts) stored.set(hash, prompt)
fs.writeFileSync(promptFile, [...stored.values()].map(item => JSON.stringify(item)).join('\n') + '\n')
fs.writeFileSync(new URL('./data/simple-items.tsv', import.meta.url), [tsv[0]!, ...tsv.slice(1).sort(order)].join('\n') + '\n')
const report = { seed: SEED, simple: PATHS.simple, kaikki: PATHS.kaikki, items: items.length, prompts: prompts.size, promptsAdded: added, leaks, counts }
fs.writeFileSync(path.join(PATHS.out, 'simple-build.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
