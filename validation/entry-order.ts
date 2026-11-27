// What the reader sees on the card, from stored scores (docs/validation.md, "The best entry first"): for each item,
// whether the labelled meaning is the very first meaning on the card, and whether it is visible in the collapsed
// card (cardPreview: three entries, three meanings each), under dictionary order, under today's order (meanings
// ordered inside each entry, entries in dictionary order) and with the entry holding the best meaning moved first
// (contextualOrder's bestEntryFirst, with and without a margin). Every order is the real contextualOrder and
// cardPreview of packages/core on placeholder definitions, as in analyze.ts; a skipped or rejected prompt, a
// "none of the above" answer or an answer later than the budget leaves dictionary order, entries included.
//
//   npx tsx validation/entry-order.ts --set wiktionary|written|simple --scores <file> [--budget 750] [--margin m] [--pack]
//   npx tsx validation/entry-order.ts --set dev [--half A|B|all] [--sweep] [--pack]
//
// --set dev reads training round 1's development items and the shipped run's float development scores
// (validation/training/README.md), leaves out the items of excluded-overlap-ids.txt as dev_eval.py does, applies no
// budget (the stored times are a GPU's) and resamples whole headwords in the bootstrap. --half splits the
// development headwords in two by a hash (halfOf). --sweep prints the margins of MARGINS and the one the rule of
// chooseMargin picks. --pack looks every item up again in the real pack, checks that its meaning counts are the
// item's, and reports the parts of speech on either side of each gained and lost item. --margin defaults to the
// extension's RANKER_DEFAULTS.entryMargin. Output: markdown on stdout, numbers and identifiers only.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { contextualOrder, openWiktionaryDictionary, type OrderOptions, type SenseRequest } from '@andrepaim/contextual-dictionary-core'
import { cardPreview } from '@andrepaim/contextual-dictionary-core/card'
import type { DictionaryResult, SenseFormat } from '../src/shared/contracts'
import { RANKER_DEFAULTS } from '../src/sense/ranker'
import { ENTRY_BUCKETS, PATHS, bucketLabel, bucketOf, fileSource, pairedInterval, readFormat, readJsonl, sha256Hex } from './common'

type CapInfo = { skip: string } | { prompt: string; candidates: Array<[number, number]>; labelledOffered: boolean }
export interface Item {
  id: string; word: string; pos: string; meanings: number; selection: { text: string; before?: string; after?: string }
  labelled: { entry: number; sense: number }; entrySenses: number[]; total: number; perCap: Record<string, CapInfo>
}
type Score = { hash: string; type: string; code?: string | null; logits?: number[]; ms: number }

/** The prompt the extension builds by default: at most 24 meanings and 1,600 characters. */
const VARIANT = '24|c1600'
/** The margins tried on the development set, in probability. */
export const MARGINS = Array.from({ length: 11 }, (_, i) => i / 20)
/** Weight of an item made worse against an item gained, in the rule that chooses the margin (chooseMargin). */
export const LOSS_WEIGHT = 2

/**
 * The development half of a headword: A when the first 32 bits of sha256(`entry-order-r1\n${word}`) fall in the
 * lower half of their range, else B. Fixed before any development number was looked at.
 */
export const halfOf = (word: string) => (parseInt(sha256Hex(`entry-order-r1\n${word}`).slice(0, 8), 16) < 2 ** 31 ? 'A' : 'B')

/**
 * The rule that chooses the margin, stated before the development numbers were looked at: the margin of MARGINS
 * with the most items gained minus LOSS_WEIGHT times the items made worse (first meaning on the card, against
 * today's order); the smaller margin on a tie. An item made worse loses a right first meaning the card showed
 * before, so it counts twice: a larger margin is worth it when it saves one item made worse for fewer than two
 * gains it gives up.
 */
export function chooseMargin(rows: Array<{ margin: number; gained: number; worse: number }>): number {
  let best = rows[0]!
  for (const row of rows) if (row.gained - LOSS_WEIGHT * row.worse > best.gained - LOSS_WEIGHT * best.worse) best = row
  return best.margin
}

type Order = 'dictionary' | 'today' | { margin: number }
interface Seen { status: string; entryFirst: boolean; cardFirst: boolean; visible: boolean; moved: boolean; firstEntry: number }

/** What the card shows for one item under one order. */
function seen(item: Item, scores: Map<string, Score>, format: SenseFormat, budget: number, order: Order): Seen {
  const key = `${item.labelled.entry}:${item.labelled.sense}`
  const result: DictionaryResult = {
    query: item.word, source: { name: '', license: '', url: '' },
    entries: item.entrySenses.map((count, e) => ({ lemma: '', partOfSpeech: '', senses: Array.from({ length: count }, (_, s) => ({ definition: `${e}:${s}`, examples: [] })) })),
  }
  const show = (shown: DictionaryResult, status: string, entryPositions?: number[]): Seen => {
    const preview = cardPreview(shown.entries, false)
    const place = shown.entries.findIndex(entry => entry.senses.some(sense => sense.definition === key))
    return {
      status,
      entryFirst: shown.entries[place]!.senses[0]!.definition === key,
      cardFirst: preview.entries[0]?.senses[0]?.sense.definition === key,
      visible: preview.entries.some(entry => entry.senses.some(({ sense }) => sense.definition === key)),
      moved: !!entryPositions && entryPositions[0] !== 0,
      firstEntry: entryPositions?.[0] ?? 0,
    }
  }
  const info = item.perCap[VARIANT]
  if (!info) throw new Error(`no ${VARIANT} prompt for ${item.id}`)
  if ('skip' in info) return show(result, `skipped: ${info.skip}`)
  if (order === 'dictionary') return show(result, 'dictionary')
  const score = scores.get(info.prompt)
  if (!score) return show(result, 'missing')
  if (score.type !== 'scored' || !score.logits) return show(result, `rejected: ${score.code}`)
  if (score.ms > budget) return show(result, 'late')
  const logits = new Float32Array(128)
  score.logits.slice(0, -1).forEach((value, i) => { logits[i] = value })
  logits[format.nota_index] = score.logits.at(-1)!
  const request: SenseRequest = { prompt: '', target: { start: 0, end: 0, text: '' }, candidates: info.candidates.map(([entry, sense]) => ({ entry, sense })), total: item.total }
  const options: OrderOptions = order === 'today' ? {} : { bestEntryFirst: true, entryMargin: order.margin }
  const ordered = contextualOrder(result, request, logits, format, options)
  if (!ordered.applied) return show(result, ordered.reason === 'NONE_FITS' ? 'none of the above' : 'invalid')
  return show(ordered.result, 'applied', ordered.entryPositions)
}

// ------------------------------------------------------------------------------------------------ inputs

const { values } = parseArgs({ options: {
  set: { type: 'string', default: 'wiktionary' }, items: { type: 'string' }, scores: { type: 'string' }, exclude: { type: 'string' },
  budget: { type: 'string' }, margin: { type: 'string' }, half: { type: 'string', default: 'all' }, sweep: { type: 'boolean', default: false },
  pack: { type: 'boolean', default: false }, seed: { type: 'string', default: '1' },
} })
const DEV = values.set === 'dev'
const TRAIN = path.join(PATHS.out, 'train')
const itemsFile = values.items ?? (DEV ? path.join(TRAIN, 'data/dev-items.jsonl') : path.join(PATHS.out, `${values.set}-items.jsonl`))
const scoresFile = values.scores ?? (DEV ? path.join(TRAIN, 'teacher/s2-labels-teacher-dev-fp32.jsonl') : path.join(PATHS.out, 'scores-8.jsonl'))
const excludeFile = values.exclude ?? (DEV ? path.join(TRAIN, 'data/excluded-overlap-ids.txt') : undefined)
const budget = values.budget === undefined ? (DEV ? Infinity : 750) : values.budget === 'none' ? Infinity : Number(values.budget)
const margin = values.margin === undefined ? RANKER_DEFAULTS.entryMargin : Number(values.margin)
const seed = Number(values.seed)
const format = readFormat()

const excluded = new Set(excludeFile ? fs.readFileSync(excludeFile, 'utf8').split('\n').filter(Boolean) : [])
const all = readJsonl<Item>(itemsFile)
if (!all.length) throw new Error(`no items in ${itemsFile}`)
const items = all.filter(item => !excluded.has(item.id) && (values.half === 'all' || halfOf(item.word) === values.half))
const scores = new Map(readJsonl<Score>(scoresFile).map(score => [score.hash, score]))
// Development items are several passages of each headword: resample headwords, not items.
const groups = DEV ? items.map(item => item.word) : undefined

// Weighting to the extract's entries, as analyze.ts does for the Wiktionary set.
const buildFile = path.join(PATHS.out, 'wiktionary-build.json')
const stratumOf = (item: Item) => { const bucket = bucketOf(ENTRY_BUCKETS, item.meanings); return bucket ? bucketLabel(bucket) : String(item.meanings) }
let weights: number[] | undefined
if (values.set === 'wiktionary' && fs.existsSync(buildFile)) {
  const counts = JSON.parse(fs.readFileSync(buildFile, 'utf8')).counts as Record<string, number>
  const per = new Map<string, number>()
  for (const item of items) per.set(stratumOf(item), (per.get(stratumOf(item)) ?? 0) + 1)
  weights = items.map(item => (counts[`entries with a usable example, stratum ${stratumOf(item)}`] ?? 0) / per.get(stratumOf(item))!)
}

// ------------------------------------------------------------------------------------------------ output

const lines: string[] = []
const out = (line = '') => lines.push(line)
const table = (header: string[], rows: Array<Array<string | number>>) => {
  out(`| ${header.join(' | ')} |`)
  out(`| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`)
  for (const row of rows) out(`| ${row.join(' | ')} |`)
  out()
}
const n = items.length
const pct = (value: number) => `${(100 * value).toFixed(1)}%`
const share = (count: number, of = n) => `${count} (${pct(count / Math.max(1, of))})`
const mean = (list: boolean[]) => list.filter(Boolean).length / Math.max(1, list.length)
const weighted = (list: boolean[]) => list.reduce((sum, value, i) => sum + (value ? weights![i]! : 0), 0) / weights!.reduce((a, b) => a + b, 0)
const run = (order: Order) => items.map(item => seen(item, scores, format, budget, order))
type Measure = 'entryFirst' | 'cardFirst' | 'visible'
const ints = (list: Seen[], measure: Measure) => list.map(x => (x[measure] ? 1 : 0))
/** `a` against `b` on one measure: difference, its interval, items gained and items made worse. */
function compare(a: Seen[], b: Seen[], measure: Measure) {
  const [low, high] = pairedInterval(ints(a, measure), ints(b, measure), seed, groups)
  const gained = a.filter((x, i) => x[measure] && !b[i]![measure]).length
  const worse = a.filter((x, i) => !x[measure] && b[i]![measure]).length
  return { delta: mean(a.map(x => x[measure])) - mean(b.map(x => x[measure])), low, high, gained, worse }
}
const deltaText = (c: ReturnType<typeof compare>) => `${c.delta >= 0 ? '+' : ''}${pct(c.delta)} (${pct(c.low)} to ${pct(c.high)})`

const dictionary = run('dictionary'), today = run('today'), unmargined = run({ margin: 0 })
const missing = today.filter(x => x.status === 'missing').length

out(`## ${values.set} set${values.half === 'all' ? '' : `, half ${values.half}`}: ${n} items${excluded.size ? ` (${all.length - n} left out)` : ''}`)
out()
out(`Scores: \`${path.basename(scoresFile)}\`; prompt ${VARIANT}; budget ${budget === Infinity ? 'none' : `${budget} ms`}; bootstrap ${groups ? `by headword (${new Set(groups).size} headwords)` : 'by item'}, 2,000 resamples, seed ${seed}.${missing ? ` **${missing} items have no score.**` : ''}`)
out()
const statuses = new Map<string, number>()
for (const x of today) statuses.set(x.status, (statuses.get(x.status) ?? 0) + 1)
out(`Outcomes: ${[...statuses.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => `${status} ${count}`).join(', ')}.`)
out()

if (values.sweep) {
  out('### Margins (best entry first, against today)')
  out()
  const rows = MARGINS.map(m => {
    const shown = m === 0 ? unmargined : run({ margin: m })
    const card = compare(shown, today, 'cardFirst'), visible = compare(shown, today, 'visible')
    return { margin: m, gained: card.gained, worse: card.worse, moved: shown.filter(x => x.moved).length, card, visible, shown }
  })
  table(['Margin', 'Entry moved', 'First on card', 'Δ (95% CI)', 'Gained', 'Made worse', `Gained − ${LOSS_WEIGHT} × worse`, 'Visible', 'Δ visible', 'Visible: gained', 'Visible: made worse'],
    rows.map(r => [r.margin.toFixed(2), r.moved, pct(mean(r.shown.map(x => x.cardFirst))), deltaText(r.card), r.gained, r.worse, r.gained - LOSS_WEIGHT * r.worse,
      pct(mean(r.shown.map(x => x.visible))), deltaText(r.visible), r.visible.gained, r.visible.worse]))
  out(`Margin chosen by the rule (most gained − ${LOSS_WEIGHT} × made worse, the smaller on a tie): **${chooseMargin(rows).toFixed(2)}**.`)
  out()
}

const margined = margin === 0 ? unmargined : run({ margin })
const orders: Array<[string, Seen[]]> = [
  ['Dictionary order', dictionary],
  ['Today: meanings by context inside each entry, entries in dictionary order', today],
  ['Best entry first, no margin', unmargined],
  [`Best entry first, margin ${margin}`, margined],
]
out('### What the reader sees')
out()
table(['Order', 'First in its entry', 'First on the card', 'Visible in the collapsed card', ...(weights ? ['Weighted: in entry', 'Weighted: on card', 'Weighted: visible'] : [])],
  orders.map(([name, list]) => [name, share(list.filter(x => x.entryFirst).length), share(list.filter(x => x.cardFirst).length), share(list.filter(x => x.visible).length),
    ...(weights ? [pct(weighted(list.map(x => x.entryFirst))), pct(weighted(list.map(x => x.cardFirst))), pct(weighted(list.map(x => x.visible)))] : [])]))

out('### Differences (paired)')
out()
const pairs: Array<[string, Seen[], Seen[]]> = [
  ['Today − dictionary order', today, dictionary],
  ['Best entry first, no margin − today', unmargined, today],
  [`Best entry first, margin ${margin} − today`, margined, today],
  ...(margin === 0 ? [] : [[`Margin ${margin} − no margin`, margined, unmargined] as [string, Seen[], Seen[]]]),
]
table(['Comparison', 'First on card: Δ (95% CI)', 'Gained', 'Made worse', 'Visible: Δ (95% CI)', 'Gained', 'Made worse', ...(weights ? ['Weighted Δ: on card', 'Weighted Δ: visible'] : [])],
  pairs.map(([name, a, b]) => {
    const card = compare(a, b, 'cardFirst'), visible = compare(a, b, 'visible')
    return [name, deltaText(card), card.gained, card.worse, deltaText(visible), visible.gained, visible.worse,
      ...(weights ? [pct(weighted(a.map(x => x.cardFirst)) - weighted(b.map(x => x.cardFirst))), pct(weighted(a.map(x => x.visible)) - weighted(b.map(x => x.visible)))] : [])]
  }))
out(`The entry holding the best meaning moved first in ${share(unmargined.filter(x => x.moved).length)} lookups without a margin and ${share(margined.filter(x => x.moved).length)} with margin ${margin}.`)
out()

// Why the labelled meaning is not first on the card.
const cause = (item: Item, x: Seen) => {
  if (x.cardFirst) return undefined
  if (x.entryFirst) return 'right in its entry; its entry is not first'
  const info = item.perCap[VARIANT]!
  const reason = x.status === 'applied'
    ? ('skip' in info || info.labelledOffered ? 'another meaning ranked higher' : 'not offered (24-meaning cap or 1,600 characters)')
    : x.status === 'dictionary' ? 'dictionary order' : x.status
  return `wrong in its entry: ${reason}`
}
out('### Why the labelled meaning is not first on the card')
out()
{
  const causes = new Map<string, [number, number]>()
  items.forEach((item, i) => {
    for (const [k, list] of [[0, today], [1, margined]] as const) {
      const c = cause(item, list[i]!)
      if (!c) continue
      const counts = causes.get(c) ?? [0, 0]
      counts[k]++
      causes.set(c, counts)
    }
  })
  table(['Cause', 'Today', `Best entry first, margin ${margin}`], [...causes.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([c, [t, m]]) => [c, share(t), share(m)]))
}

if (values.pack) {
  // The parts of speech on either side of each change, from a fresh lookup of every item in the real pack.
  const source = await fileSource(PATHS.pack)
  const dictionary = await openWiktionaryDictionary(source)
  let mismatched = 0
  const kinds = new Map<string, number>()
  const count = (kind: string) => kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  for (const [i, item] of items.entries()) {
    const a = margined[i]!, b = today[i]!
    if (a.cardFirst === b.cardFirst) continue
    const result = await dictionary.define(item.selection)
    if (JSON.stringify(result.entries.map(entry => entry.senses.length)) !== JSON.stringify(item.entrySenses)) { mismatched++; continue }
    const labelled = result.entries[item.labelled.entry]!
    const other = a.cardFirst ? result.entries[0]! : result.entries[a.firstEntry]!
    const pos = other.partOfSpeech === labelled.partOfSpeech ? 'the same part of speech as the labelled one' : 'another part of speech'
    const lemma = other.lemma === labelled.lemma ? '' : ', another headword or spelling'
    count(a.cardFirst ? `gained: the labelled entry moved up past an entry of ${pos}${lemma}` : `made worse: an entry of ${pos}${lemma} moved first`)
  }
  await source.close()
  out(`### Gains and losses by part of speech (margin ${margin}, against today; fresh pack lookups)`)
  out()
  table(['Change', 'Items'], [...kinds.entries()].sort().map(([kind, items]) => [kind, items]))
  out(`Items whose fresh lookup gave other meaning counts than the item's (left out): ${mismatched}.`)
  out()
}

console.log(lines.join('\n'))
