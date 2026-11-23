// Turns the evaluation items and the model's answers into the tables of
// docs/validation.md: accuracy of dictionary order and model order, the
// effect of the candidate cap, latency by meanings offered, and budget
// coverage.
//
//   npx tsx validation/analyze.ts [--set wiktionary|written] [--threads 8] [--seed 1]
//
// Model order is computed with the extension's own contextualOrder
// (src/sense/prompt.ts) on the stored logits; a prompt that was skipped or
// rejected, a "none of the above" answer, or an answer later than the budget
// leaves dictionary order, exactly as in the extension.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { contextualOrder, type SenseRequest } from '../src/sense/prompt'
import type { DictionaryResult } from '../src/shared/contracts'
import { BUDGETS, ENTRY_BUCKETS, OFFERED_BUCKETS, VARIANTS, PATHS, bucketLabel, bucketOf, percentile, readFormat, readJsonl } from './common'

const { values } = parseArgs({ options: { set: { type: 'string', default: 'wiktionary' }, threads: { type: 'string', default: '8' }, seed: { type: 'string', default: '1' } } })
const format = readFormat()

type CapInfo = { skip: string } | { prompt: string; candidates: Array<[number, number]>; labelledOffered: boolean }
export interface Item {
  id: string; word: string; pos: string; stratum?: string; genre?: string; meanings: number
  labelled: { entry: number; sense: number }; entrySenses: number[]; total: number; perCap: Record<string, CapInfo>
}
type Score = { hash: string; type: string; code?: string; logits?: number[]; ms: number; tokens: number; offered: number }

const items = readJsonl<Item>(path.join(PATHS.out, `${values.set}-items.jsonl`))
const PRESENT = VARIANTS.filter(({ key }) => items.every(item => item.perCap[key] !== undefined))
const scores = new Map(readJsonl<Score>(path.join(PATHS.out, `scores-${values.threads}.jsonl`)).map(score => [score.hash, score]))

/** What the extension would show for one item at one cap and budget. */
export function outcome(item: Item, cap: number | string, budget = Infinity): { rank: number; result: string; ms?: number; offered?: number } {
  const dictionary = item.labelled.sense + 1
  const info = item.perCap[cap]
  if (!info) throw new Error(`no cap ${cap} for ${item.id}`)
  if ('skip' in info) return { rank: dictionary, result: `skipped: ${info.skip}` }
  const score = scores.get(info.prompt)
  if (!score) return { rank: dictionary, result: 'missing' }
  if (score.type !== 'scored' || !score.logits) return { rank: dictionary, result: `rejected: ${score.code}`, ms: score.ms, offered: score.offered }
  if (score.ms > budget) return { rank: dictionary, result: 'late', ms: score.ms, offered: score.offered }
  const logits = new Float32Array(128)
  score.logits.slice(0, -1).forEach((value, i) => { logits[i] = value })
  logits[format.nota_index] = score.logits.at(-1)!
  // The real reorder, on placeholder definitions that name their own position.
  const result: DictionaryResult = {
    query: item.word, source: { name: '', license: '', url: '' },
    entries: item.entrySenses.map((count, e) => ({ lemma: '', partOfSpeech: '', senses: Array.from({ length: count }, (_, s) => ({ definition: `${e}:${s}`, examples: [] })) })),
  }
  const request: SenseRequest = { prompt: '', target: { start: 0, end: 0, text: '' }, candidates: info.candidates.map(([entry, sense]) => ({ entry, sense })), total: item.total }
  const ordered = contextualOrder(result, request, logits, format)
  if (!ordered.applied) return { rank: dictionary, result: ordered.reason === 'NONE_FITS' ? 'none of the above' : 'invalid', ms: score.ms, offered: score.offered }
  const rank = ordered.result.entries[item.labelled.entry]!.senses.findIndex(sense => sense.definition === `${item.labelled.entry}:${item.labelled.sense}`) + 1
  return { rank, result: 'applied', ms: score.ms, offered: score.offered }
}

const pct = (value: number) => `${(100 * value).toFixed(1)}%`
const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / Math.max(1, list.length)
function summary(ranks: number[]) {
  return { n: ranks.length, top1: mean(ranks.map(rank => (rank === 1 ? 1 : 0))), top3: mean(ranks.map(rank => (rank <= 3 ? 1 : 0))), meanRank: mean(ranks) }
}

/** A seeded bootstrap 95% interval of the paired difference model minus dictionary. */
function pairedInterval(model: number[], dictionary: number[], seed: number): [number, number] {
  let state = seed >>> 0 || 1
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32 }
  const n = model.length, diffs: number[] = []
  for (let b = 0; b < 2000; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) { const j = Math.floor(random() * n); sum += model[j]! - dictionary[j]! }
    diffs.push(sum / n)
  }
  diffs.sort((a, b) => a - b)
  return [percentile(diffs, 2.5), percentile(diffs, 97.5)]
}

const lines: string[] = []
const out = (line = '') => lines.push(line)
const table = (header: string[], rows: string[][]) => {
  out(`| ${header.join(' | ')} |`)
  out(`| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`)
  for (const row of rows) out(`| ${row.join(' | ')} |`)
  out()
}

const DEFAULT_CAP = 48
const groupBy = (key: (item: Item) => string) => {
  const groups = new Map<string, Item[]>()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}
const accuracyRows = (groups: Map<string, Item[]>, cap: number, order?: string[]) => [...groups.entries()]
  .sort((a, b) => (order ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1].length - a[1].length))
  .map(([name, group]) => {
    const dictionary = summary(group.map(item => item.labelled.sense + 1))
    const model = summary(group.map(item => outcome(item, cap).rank))
    return [name, String(group.length), pct(dictionary.top1), pct(model.top1), pct(dictionary.top3), pct(model.top3), dictionary.meanRank.toFixed(2), model.meanRank.toFixed(2)]
  })
const ACC_HEADER = ['Group', 'Items', 'First, dictionary', 'First, model', 'Top 3, dictionary', 'Top 3, model', 'Mean rank, dictionary', 'Mean rank, model']

out(`## ${values.set} set: ${items.length} items, model answers from ${values.threads} threads`)
out()
const missing = items.filter(item => PRESENT.some(({ key }) => outcome(item, key).result === 'missing')).length
if (missing) out(`**${missing} items have prompts without an answer yet.**\n`)

for (const cap of [DEFAULT_CAP, 16, 127]) {
  const model = items.map(item => (outcome(item, cap).rank === 1 ? 1 : 0)), dictionary = items.map(item => (item.labelled.sense === 0 ? 1 : 0))
  const model3 = items.map(item => (outcome(item, cap).rank <= 3 ? 1 : 0)), dictionary3 = items.map(item => (item.labelled.sense <= 2 ? 1 : 0))
  const [low, high] = pairedInterval(model, dictionary, Number(values.seed))
  const [low3, high3] = pairedInterval(model3, dictionary3, Number(values.seed) + 1)
  out(`Cap ${cap === 127 ? 'none (127)' : cap}: first meaning, model minus dictionary ${pct(mean(model) - mean(dictionary))} (95% bootstrap interval ${pct(low)} to ${pct(high)}); top three ${pct(mean(model3) - mean(dictionary3))} (${pct(low3)} to ${pct(high3)}).`)
  out()
}

out(`### Accuracy at cap ${DEFAULT_CAP}, no budget, by meanings in the labelled entry`)
out()
const strata = ['1', ...ENTRY_BUCKETS.map(bucketLabel)]
const stratumOf = (item: Item) => { const bucket = bucketOf(ENTRY_BUCKETS, item.meanings); return bucket ? bucketLabel(bucket) : String(item.meanings) }
const byStratum = groupBy(stratumOf)
table(ACC_HEADER, [...accuracyRows(byStratum, DEFAULT_CAP, strata), accuracyRows(new Map([['All', items]]), DEFAULT_CAP)[0]!])
if (values.set === 'wiktionary' && fs.existsSync(path.join(PATHS.out, 'wiktionary-build.json'))) {
  // The sample is stratified; weighting each stratum by the entries it stands for in the extract
  // (entries with two or more meanings and a usable example) gives the distribution of Wiktionary entries.
  const counts = JSON.parse(fs.readFileSync(path.join(PATHS.out, 'wiktionary-build.json'), 'utf8')).counts as Record<string, number>
  const weight = (stratum: string) => (counts[`entries with a usable example, stratum ${stratum}`] ?? 0) / Math.max(1, byStratum.get(stratum)?.length ?? 0)
  const weighted = (rank: (item: Item) => number, test: (rank: number) => boolean) => {
    let sum = 0, total = 0
    for (const item of items) { const w = weight(stratumOf(item)); total += w; sum += w * (test(rank(item)) ? 1 : 0) }
    return sum / total
  }
  const dict = (item: Item) => item.labelled.sense + 1, model = (item: Item) => outcome(item, DEFAULT_CAP).rank
  out(`Weighted to the extract's entries (strata weighted by how many entries they stand for): first meaning ${pct(weighted(dict, r => r === 1))} dictionary, ${pct(weighted(model, r => r === 1))} model; top three ${pct(weighted(dict, r => r <= 3))} dictionary, ${pct(weighted(model, r => r <= 3))} model.`)
  out()
}

out(`### Accuracy at cap ${DEFAULT_CAP}, no budget, by part of speech`)
out()
const mainPos = ['noun', 'verb', 'adj', 'adv']
table(ACC_HEADER, accuracyRows(groupBy(item => (mainPos.includes(item.pos) ? item.pos : 'other')), DEFAULT_CAP))
if (values.set === 'written') {
  out('### By genre')
  out()
  table(ACC_HEADER, accuracyRows(groupBy(item => item.genre ?? '?'), DEFAULT_CAP))
}

out('### Outcomes by cap (no budget)')
out()
const results = ['applied', 'none of the above', 'rejected: TOO_LONG', 'skipped: NOT_ENGLISH', 'skipped: TOO_MANY_SENSES', 'skipped: UNSAFE_TEXT', 'skipped: TOO_LONG']
const capRows = PRESENT.map(({ key: cap }) => {
  const outcomes = items.map(item => outcome(item, cap))
  const notOffered = items.filter(item => { const info = item.perCap[cap]!; return !('skip' in info) && !info.labelledOffered }).length
  const ranks = summary(outcomes.map(o => o.rank))
  const other = outcomes.filter(o => !results.includes(o.result)).length
  return [cap === '127' ? 'none (127)' : cap, ...results.map(result => pct(outcomes.filter(o => o.result === result).length / items.length)), other ? String(other) : '0',
    pct(notOffered / items.length), pct(ranks.top1), pct(ranks.top3), ranks.meanRank.toFixed(2)]
})
table(['Cap', 'Applied', 'None of the above', 'Rejected, too long', 'Skipped, not English', 'Skipped, nothing to reorder', 'Skipped, unsafe text', 'Skipped, too long', 'Other', 'Labelled meaning not offered', 'First', 'Top 3', 'Mean rank'], capRows)
{
  const dictionary = summary(items.map(item => item.labelled.sense + 1))
  out(`Dictionary order: first ${pct(dictionary.top1)}, top three ${pct(dictionary.top3)}, mean rank ${dictionary.meanRank.toFixed(2)}.`)
  out()
}

// ------------------------------------------------------------------ latency

const scored = [...scores.values()].filter(score => score.type === 'scored')
const used = new Set(items.flatMap(item => Object.values(item.perCap).flatMap(info => ('prompt' in info ? [info.prompt] : []))))
const mine = scored.filter(score => used.has(score.hash))
out(`### Latency of one prompt, ${values.threads} threads (${mine.length} distinct prompts of this set)`)
out()
const latencyRows = [...OFFERED_BUCKETS, [1, Infinity] as const].map(bucket => {
  const group = mine.filter(score => score.offered >= bucket[0] && score.offered <= bucket[1])
  const ms = group.map(score => score.ms).sort((a, b) => a - b), tokens = group.map(score => score.tokens).sort((a, b) => a - b)
  return [bucket[1] === Infinity && bucket[0] === 1 ? 'All' : bucketLabel(bucket), String(group.length), String(percentile(tokens, 50)), percentile(ms, 50).toFixed(0), percentile(ms, 90).toFixed(0), percentile(ms, 99).toFixed(0), (ms.at(-1) ?? NaN).toFixed(0)]
})
table(['Meanings offered', 'Prompts', 'Median tokens', 'p50 ms', 'p90 ms', 'p99 ms', 'Max ms'], latencyRows)
{
  const rejected = [...scores.values()].filter(score => used.has(score.hash) && score.type !== 'scored')
  out(`Rejected by the worker: ${rejected.length} prompts (${[...new Set(rejected.map(score => score.code))].join(', ') || 'none'}), with ${rejected.map(score => score.tokens).sort((a, b) => a - b).join(', ') || '–'} tokens.`)
  out()
}

// ------------------------------------------------------------ budget coverage

out(`### Budget coverage: ambiguous lookups, ${values.threads} threads`)
out()
out('An ambiguous lookup is one for which the extension builds a prompt (some entry has two meanings to reorder, the passage passes the English and safety checks). "Answered" means the model answered within the budget; "ordered" means its order was also applied (not "none of the above"). Accuracy counts every item, with dictionary order where the model did not answer in time.')
out()
const coverageRows: string[][] = []
for (const { key: cap } of PRESENT) {
  for (const budget of BUDGETS) {
    const ambiguous = items.filter(item => !('skip' in item.perCap[cap]!))
    const outcomes = items.map(item => outcome(item, cap, budget))
    const answered = ambiguous.filter(item => { const o = outcome(item, cap, budget); return o.result === 'applied' || o.result === 'none of the above' }).length
    const ordered = ambiguous.filter(item => outcome(item, cap, budget).result === 'applied').length
    const ranks = summary(outcomes.map(o => o.rank))
    coverageRows.push([cap === '127' ? 'none' : cap, String(budget), pct(answered / ambiguous.length), pct(ordered / ambiguous.length), pct(ranks.top1), pct(ranks.top3), ranks.meanRank.toFixed(2)])
  }
}
table(['Cap', 'Budget ms', 'Answered in time', 'Order applied', 'First', 'Top 3', 'Mean rank'], coverageRows)

console.log(lines.join('\n'))
