// Unlabelled prompts from Wikipedia paragraphs (training round 1, teacher-only stream; docs/validation.md).
// Input: paragraphs sampled by validation/dataset/wiki_paragraphs.py from one English Wikipedia parquet shard.
// For each paragraph (seeded order of its lower-case word tokens), the first word whose lookup in the real
// pack gives a prompt (the extension's senseRequest via variantRequest, variants 24|c1600 and 127) and whose
// lookup result has no held-out lemma (data/wiktionary-items.tsv, data/written-labels.tsv) and no lemma on the
// development side of the training split; at most --per-lemma prompts per looked-up lemma set.
//   npx tsx validation/build-unlabelled-set.ts --input ~/.cache/contextual-dictionary/validation/train/data/wiki-paragraphs.jsonl
// Writes unlabelled-items.jsonl, unlabelled-prompts.jsonl and unlabelled-build.json under CD_TRAIN_OUT (default
// ~/.cache/contextual-dictionary/validation/train/data). Contains Wikipedia text: never committed.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openWiktionaryDictionary } from '@andrepaim/contextual-dictionary-core'
import { PATHS, VARIANTS, fileSource, readFormat, selectionAt, sha256Hex, tokenCounter, variantRequest } from './common'
import { blockedLookup, heldOutHeadwords, isDevelopmentHeadword } from './training-items'

const { values } = parseArgs({ options: {
  input: { type: 'string' }, seed: { type: 'string', default: 'cd-train-r1' }, 'dev-share': { type: 'string', default: '0.04' },
  'per-lemma': { type: 'string', default: '15' }, tries: { type: 'string', default: '8' },
} })
const SEED = values.seed!, DEV_SHARE = Number(values['dev-share']), PER_LEMMA = Number(values['per-lemma']), TRIES = Number(values.tries)
const variants = VARIANTS.filter(v => ['24|c1600', '127'].includes(v.key))
const data = (name: string) => fs.readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const HELD_OUT = heldOutHeadwords(data('wiktionary-items.tsv'), data('written-labels.tsv'))
const isDev = (word: string) => isDevelopmentHeadword(word, SEED, DEV_SHARE)

/** Outputs hold Wiktionary or Wikipedia text: under ~/.cache, never in the repository. */
const OUT = process.env.CD_TRAIN_OUT ?? path.join(PATHS.out, 'train', 'data')
fs.mkdirSync(OUT, { recursive: true })
const counts: Record<string, number> = {}
const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
const format = readFormat(), tokens = tokenCounter()
const source = await fileSource(PATHS.pack)
const dictionary = await openWiktionaryDictionary(source)
const perLemma = new Map<string, number>()
const items: string[] = [], prompts = new Map<string, string>()
const paragraphs = fs.readFileSync(values.input!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { doc: string; para: number; text: string })
for (const [n, p] of paragraphs.entries()) {
  if (n % 10_000 === 0) console.error(`${n}/${paragraphs.length}, ${items.length} items`)
  const words = [...p.text.matchAll(/\p{L}+/gu)].filter(m => /^[a-z]{3,}$/u.test(m[0]))
    .map(m => ({ start: m.index!, end: m.index! + m[0].length, word: m[0], rank: sha256Hex(`${SEED}\n${p.doc}\n${p.para}\n${m.index}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, TRIES)
  let made = false
  for (const w of words) {
    if (HELD_OUT.has(w.word) || isDev(w.word)) { count('tries: held-out or development word'); continue }
    const selection = selectionAt(p.text, w.start, w.end)
    const result = await dictionary.define(selection)
    if (!result.entries.length) { count('tries: not in the pack'); continue }
    const lemmas = [...new Set(result.entries.map(e => e.lemma))].sort()
    if (blockedLookup(w.word, lemmas, HELD_OUT, isDev)) { count('tries: lookup returns a held-out or development lemma'); continue }
    const key = lemmas.join('|')
    if ((perLemma.get(key) ?? 0) >= PER_LEMMA) { count('tries: lemma limit reached'); continue }
    const perCap: Record<string, unknown> = {}
    let any = false
    for (const variant of variants) {
      const request = variantRequest(result, selection, format, variant)
      if ('skip' in request) { perCap[variant.key] = { skip: request.skip }; continue }
      any = true
      const hash = sha256Hex(request.prompt)
      if (!prompts.has(hash)) prompts.set(hash, JSON.stringify({ hash, prompt: request.prompt, tokens: tokens(request.prompt), offered: request.candidates.length, target: request.target }))
      perCap[variant.key] = { prompt: hash, candidates: request.candidates.map(x => [x.entry, x.sense]) }
    }
    if (!any) { count('tries: no prompt (single meanings, not English, ...)'); continue }
    perLemma.set(key, (perLemma.get(key) ?? 0) + 1)
    items.push(JSON.stringify({ id: `wiki|${p.doc}|${p.para}|${w.start}`, word: w.word, lemmas, selection, entrySenses: result.entries.map(e => e.senses.length), perCap }))
    made = true
    break
  }
  count(made ? 'paragraphs with an item' : 'paragraphs without an item')
}
await source.close()
fs.writeFileSync(path.join(OUT, 'unlabelled-items.jsonl'), items.join('\n') + '\n')
fs.writeFileSync(path.join(OUT, 'unlabelled-prompts.jsonl'), [...prompts.values()].join('\n') + '\n')
const report = { seed: SEED, input: values.input, items: items.length, prompts: prompts.size, lemmaSets: perLemma.size, counts }
fs.writeFileSync(path.join(OUT, 'unlabelled-build.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
