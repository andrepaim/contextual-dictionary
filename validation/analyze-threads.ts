// Latency with fewer threads, standing in for smaller machines: the same
// prompts (a fixed subset, threads-subset.txt) scored with 8, 4 and 2 threads,
// and the share of the subset's lookups answered within each budget.
//
//   npx tsx validation/analyze-threads.ts
import fs from 'node:fs'
import path from 'node:path'
import { BUDGETS, OFFERED_BUCKETS, PATHS, bucketLabel, percentile, readJsonl } from './common'

type Score = { hash: string; type: string; ms: number; tokens: number; offered: number }
type Item = { id: string; perCap: Record<string, { prompt?: string; skip?: string }> }
const subset = new Set(fs.readFileSync(path.join(PATHS.out, 'threads-subset.txt'), 'utf8').split('\n').filter(Boolean))
const byThreads = new Map([8, 4, 2].map(threads => [threads, new Map(readJsonl<Score>(path.join(PATHS.out, `scores-${threads}.jsonl`)).filter(score => subset.has(score.hash)).map(score => [score.hash, score]))]))
const items = readJsonl<Item>(path.join(PATHS.out, 'wiktionary-items.jsonl')).sort((a, b) => (a.id < b.id ? -1 : 1)).filter((_, i) => i % 5 === 0).slice(0, 300)

const lines: string[] = []
lines.push(`### Latency by meanings offered and threads (${subset.size} prompts of 300 items: caps 48, 48 with 1,200 and with 1,600 characters)`, '')
lines.push('| Meanings offered | Prompts | 8 threads p50 / p90 ms | 4 threads p50 / p90 ms | 2 threads p50 / p90 ms |', '| --- | ---: | ---: | ---: | ---: |')
for (const bucket of [...OFFERED_BUCKETS, [1, Infinity] as const]) {
  const hashes = [...subset].filter(hash => { const score = byThreads.get(8)!.get(hash); return score && score.type === 'scored' && score.offered >= bucket[0] && score.offered <= bucket[1] })
  const cell = (threads: number) => {
    const ms = hashes.map(hash => byThreads.get(threads)!.get(hash)?.ms).filter((value): value is number => value !== undefined).sort((a, b) => a - b)
    return ms.length ? `${percentile(ms, 50).toFixed(0)} / ${percentile(ms, 90).toFixed(0)}` : '–'
  }
  lines.push(`| ${bucket[0] === 1 && bucket[1] === Infinity ? 'All' : bucketLabel(bucket)} | ${hashes.length} | ${cell(8)} | ${cell(4)} | ${cell(2)} |`)
}
lines.push('')
lines.push('### Share of ambiguous lookups answered within the budget, by threads (same 300 items)', '')
lines.push(`| Prompt | Threads | ${BUDGETS.map(budget => `${budget} ms`).join(' | ')} |`, `| --- | ---: | ${BUDGETS.map(() => '---:').join(' | ')} |`)
for (const variant of ['48', '48|c1200', '48|c1600']) {
  for (const threads of [8, 4, 2]) {
    const scores = byThreads.get(threads)!
    const prompts = items.map(item => item.perCap[variant]?.prompt).filter((hash): hash is string => !!hash)
    const ms = prompts.map(hash => scores.get(hash)).filter(score => score && score.type === 'scored').map(score => score!.ms)
    if (ms.length < prompts.length * 0.9) continue
    lines.push(`| ${variant === '48' ? 'cap 48' : `cap 48, ${variant.split('c')[1]} characters`} | ${threads} | ${BUDGETS.map(budget => `${(100 * ms.filter(value => value <= budget).length / prompts.length).toFixed(0)}%`).join(' | ')} |`)
  }
}
console.log(lines.join('\n'))
