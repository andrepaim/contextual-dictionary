// Measures the real extension path in Chromium: a production build, the
// published dictionary and model in the extension's own private storage,
// lookups sent the way the popup sends them (extension page -> service
// worker -> offscreen document -> pack and model worker).
//
//   npm run build
//   npx tsx validation/extension-bench.ts --install                 # once: downloads assets-v1 into a template profile (214 MB)
//   npx tsx validation/extension-bench.ts --build dist --label after [--lookups 400] [--cap 48] [--idle]
//
// The template profile and the extension directory live under
// ~/.cache/contextual-dictionary/validation/bench/; the extension directory
// path is fixed so the extension keeps one id and its private files. Each
// run copies the template profile, so its first lookup is the first of a
// browser session. --idle also waits for the model's idle unload (10
// minutes) and measures memory again.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import type { Selection, Status } from '../src/shared/contracts'
import { OFFERED_BUCKETS, PATHS, bucketLabel, percentile, readJsonl } from './common'

const { values } = parseArgs({ options: {
  install: { type: 'boolean', default: false },
  build: { type: 'string', default: 'dist' },
  label: { type: 'string', default: 'run' },
  lookups: { type: 'string', default: '400' },
  cap: { type: 'string', default: '48' },
  budget: { type: 'string', default: '2000' },
  idle: { type: 'boolean', default: false },
} })
const BENCH = path.join(PATHS.out, 'bench')
const EXTENSION = path.join(BENCH, 'extension')
const TEMPLATE = path.join(BENCH, 'template-profile')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function prepareExtension(build: string) {
  fs.rmSync(EXTENSION, { recursive: true, force: true })
  fs.cpSync(path.resolve(build), EXTENSION, { recursive: true })
  // A blank extension page to send requests from; it runs no script, so it does not open the offscreen document itself.
  fs.writeFileSync(path.join(EXTENSION, 'bench.html'), '<!doctype html><meta charset="utf-8"><title>bench</title>')
}

async function launch(profile: string): Promise<{ context: BrowserContext; page: Page; id: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const id = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/bench.html`)
  return { context, page, id }
}

type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string }
const send = <T>(page: Page, request: unknown) => page.evaluate(message => chrome.runtime.sendMessage(message), request) as Promise<Reply<T>>
async function status(page: Page): Promise<Status> {
  const reply = await send<Status>(page, { type: 'status' })
  if (!reply.ok) throw new Error(reply.code)
  return reply.value
}
/** One lookup, timed in the page from sending to the answer. */
async function define(page: Page, selection: Selection, requestId: string) {
  return page.evaluate(async ({ selection, requestId }) => {
    const started = performance.now()
    const reply = await chrome.runtime.sendMessage({ type: 'define', requestId, selection })
    return { ms: performance.now() - started, ok: reply.ok as boolean, ordered: reply.ok ? reply.value.ordered as boolean : false, code: reply.ok ? undefined : reply.code as string, entries: reply.ok ? reply.value.result.entries.length as number : 0 }
  }, { selection, requestId })
}

/**
 * Resident and proportional memory of the extension's renderer process: the
 * offscreen document, its model worker, the service worker and the blank
 * page. Found as the descendant of this profile's browser process that runs
 * with --extension-process.
 */
function extensionMemory(profile: string): { rssMB: number; pssMB: number; processes: number } | null {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').filter(Boolean).map(line => {
    const [pid, ppid, ...args] = line.trim().split(/\s+/)
    return { pid: Number(pid), ppid: Number(ppid), args: args.join(' ') }
  })
  const root = rows.find(row => row.args.includes(`--user-data-dir=${profile}`) && !row.args.includes('--type='))
  if (!root) return null
  const family = new Set([root.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) if (family.has(row.ppid) && !family.has(row.pid)) { family.add(row.pid); grew = true }
  }
  const extension = rows.filter(row => family.has(row.pid) && row.args.includes('--type=renderer') && row.args.includes('--extension-process'))
  let rss = 0, pss = 0
  for (const { pid } of extension) {
    try {
      const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
      rss += Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0)
      pss += Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0)
    } catch { /* gone */ }
  }
  return { rssMB: Math.round(rss / 1024), pssMB: Math.round(pss / 1024), processes: extension.length }
}

if (values.install) {
  prepareExtension(values.build!)
  fs.rmSync(TEMPLATE, { recursive: true, force: true })
  const { context, page } = await launch(TEMPLATE)
  try {
    for (const bundle of ['dictionary', 'model'] as const) {
      const before = await status(page)
      const started = Date.now()
      const reply = await send(page, { type: 'download', bundle, acceptBytes: before.bundles[bundle].requiredBytes })
      if (!reply.ok) throw new Error(`${bundle}: ${reply.code}`)
      for (;;) {
        const now = await status(page)
        if (now.bundles[bundle].phase === 'ready') break
        if (now.bundles[bundle].phase === 'failed') throw new Error(`${bundle}: ${now.bundles[bundle].error}`)
        await sleep(500)
      }
      console.log(`${bundle}: ${before.bundles[bundle].requiredBytes} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
  } finally {
    await context.close()
  }
  process.exit(0)
}

// ------------------------------------------------------------------ a run

prepareExtension(values.build!)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-bench-profile-'))
fs.cpSync(TEMPLATE, profile, { recursive: true })
type Item = { id: string; selection: Selection; perCap: Record<string, { prompt?: string }> }
const prompts = new Map(readJsonl<{ hash: string; tokens: number; offered: number }>(path.join(PATHS.out, 'prompts.jsonl')).map(prompt => [prompt.hash, prompt]))
const items = readJsonl<Item>(path.join(PATHS.out, 'wiktionary-items.jsonl')).sort((a, b) => (a.id < b.id ? -1 : 1))
// A fixed, mixed sample: every fifth item in id order, so every stratum is represented.
const sample = items.filter((_, i) => i % 5 === 0).slice(0, Number(values.lookups))
const report: Record<string, unknown> = { label: values.label, build: values.build, cap: Number(values.cap), budget: Number(values.budget), load: os.loadavg(), at: new Date().toISOString() }
const { context, page } = await launch(profile)
try {
  await send(page, { type: 'set-settings', patch: { orderByContext: false, budgetMs: Number(values.budget), maxCandidates: Number(values.cap) } })
  // The first lookup of the session: creates the offscreen document, opens the stored pack (and, before the fix, hashes all 66 MB of it).
  const first = await define(page, { text: 'mouse', before: 'Drag the ', after: ' to move the cursor on screen.' }, 'first')
  report.firstLookupMs = first.ms
  const second = await define(page, { text: 'bank', before: 'She deposited the cheque at the ', after: ' on Monday.' }, 'second')
  report.secondLookupMs = second.ms
  report.memoryDictionaryOnly = extensionMemory(profile)

  // Dictionary only: the same sample with ordering off.
  const dictionaryMs: number[] = []
  for (const [i, item] of sample.entries()) dictionaryMs.push((await define(page, item.selection, `d${i}`)).ms)
  dictionaryMs.sort((a, b) => a - b)
  report.dictionaryOnly = { n: dictionaryMs.length, p50: percentile(dictionaryMs, 50), p90: percentile(dictionaryMs, 90), p99: percentile(dictionaryMs, 99), max: dictionaryMs.at(-1) }

  // Turning ordering on: time until the model is ready (reading the files, before the fix hashing them, creating the session, two warm-up prompts).
  const switched = Date.now()
  await send(page, { type: 'set-settings', patch: { orderByContext: true } })
  for (;;) {
    const now = await status(page)
    if (now.ranker.state === 'ready') break
    if (now.ranker.state === 'failed') throw new Error(`model failed: ${now.ranker.code}`)
    await sleep(20)
  }
  report.modelReadyMs = Date.now() - switched
  await sleep(1000)
  report.memoryModelLoaded = extensionMemory(profile)

  // Lookups with ordering on.
  const rows: Array<{ id: string; ms: number; ordered: boolean; offered: number | null; tokens: number | null }> = []
  for (const [i, item] of sample.entries()) {
    const answer = await define(page, item.selection, `o${i}`)
    const prompt = item.perCap[values.cap!]?.prompt ? prompts.get(item.perCap[values.cap!]!.prompt!) : undefined
    rows.push({ id: item.id, ms: answer.ms, ordered: answer.ordered, offered: prompt?.offered ?? null, tokens: prompt?.tokens ?? null })
  }
  report.memoryAfterLookups = extensionMemory(profile)
  const byBucket = [...OFFERED_BUCKETS, [0, 0] as const].map(bucket => {
    const group = rows.filter(row => (bucket[1] === 0 ? row.offered === null : row.offered !== null && row.offered >= bucket[0] && row.offered <= bucket[1]))
    const ms = group.map(row => row.ms).sort((a, b) => a - b)
    return { bucket: bucket[1] === 0 ? 'not scored' : bucketLabel(bucket), n: group.length, ordered: group.filter(row => row.ordered).length, p50: percentile(ms, 50), p90: percentile(ms, 90), p99: percentile(ms, 99) }
  })
  const all = rows.map(row => row.ms).sort((a, b) => a - b)
  report.ordering = { n: rows.length, ordered: rows.filter(row => row.ordered).length, p50: percentile(all, 50), p90: percentile(all, 90), p99: percentile(all, 99), byBucket }
  fs.writeFileSync(path.join(PATHS.out, `bench-${values.label}-lookups.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')

  if (values.idle) {
    console.error('waiting 10.5 minutes for the idle unload')
    await sleep(630_000)
    report.rankerAfterIdle = (await status(page)).ranker
    await sleep(2000)
    report.memoryAfterIdle = extensionMemory(profile)
  }
} finally {
  await context.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
fs.writeFileSync(path.join(PATHS.out, `bench-${values.label}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
