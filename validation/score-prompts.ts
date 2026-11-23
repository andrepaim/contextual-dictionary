// Scores prompts with the real model inside the built extension (Chromium,
// the production dist/ with the model files beside it, an extension page,
// the built model worker and its ONNX Runtime files), and records each
// answer and how long it took, as the ranker sees it: from posting `score`
// to receiving `scored` or `rejected`.
//
//   npm run build
//   npx tsx validation/score-prompts.ts --threads 8 [--prompts prompts.jsonl] [--only ids.txt] [--out scores-8.jsonl]
//
// Prompts are read from ~/.cache/contextual-dictionary/validation/ (written by
// build-wiktionary-set.ts and build-written-set.ts). The run resumes: prompts
// already in the output file are skipped. Each line of the output holds the
// prompt hash, the answer type, the logits of the offered meanings and of
// "none of the above", the time and the thread count.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { MODEL_FILES } from '../src/model/load'
import { PATHS, readFormat, readJsonl } from './common'

const { values } = parseArgs({ options: {
  threads: { type: 'string', default: '8' },
  prompts: { type: 'string', default: 'prompts.jsonl' },
  only: { type: 'string' },
  out: { type: 'string' },
  limit: { type: 'string' },
} })
const threads = Number(values.threads)
const out = path.resolve(PATHS.out, values.out ?? `scores-${threads}.jsonl`)
const dist = path.resolve('dist')
if (!fs.existsSync(path.join(dist, 'model-worker.js'))) throw new Error('Run npm run build first')

const format = readFormat()
type Prompt = { hash: string; prompt: string; tokens: number; offered: number }
let prompts = readJsonl<Prompt>(path.resolve(PATHS.out, values.prompts!))
if (values.only) {
  const wanted = new Set(fs.readFileSync(path.resolve(PATHS.out, values.only), 'utf8').split('\n').filter(Boolean))
  prompts = prompts.filter(prompt => wanted.has(prompt.hash))
}
const done = new Set(readJsonl<{ hash: string }>(out).map(score => score.hash))
prompts = prompts.filter(prompt => !done.has(prompt.hash)).sort((a, b) => (a.hash < b.hash ? -1 : 1))
if (values.limit) prompts = prompts.slice(0, Number(values.limit))
console.error(`${prompts.length} prompts to score with ${threads} threads (${done.size} done before)`)

const EXPORT_PATHS: Record<string, string> = {
  [MODEL_FILES.model]: 'onnx/model.int8.onnx',
  [MODEL_FILES.metadata]: 'model_metadata.json',
  [MODEL_FILES.calibration]: 'calibration.json',
  [MODEL_FILES.tokenizer]: 'tokenizer.json',
  [MODEL_FILES.tokenizerConfig]: 'tokenizer_config.json',
}

/** Page code that drives the built worker from an extension page (as test/e2e/model-real.spec.ts does). */
const HARNESS = `
const FILES = ${JSON.stringify(MODEL_FILES)}
let worker, next = 1
const pending = new Map()
window.harness = {
  isolated: () => crossOriginIsolated,
  async load(threads) {
    const bytes = name => fetch('/model/' + name).then(response => response.arrayBuffer())
    const text = name => fetch('/model/' + name).then(response => response.text())
    const [model, metadata, calibration, tokenizer, tokenizerConfig] = await Promise.all([
      bytes(FILES.model), text(FILES.metadata), text(FILES.calibration), text(FILES.tokenizer), text(FILES.tokenizerConfig),
    ])
    const started = performance.now()
    worker = new Worker('/model-worker.js', { type: 'module' })
    const answer = new Promise(resolve => {
      worker.onerror = event => resolve({ type: 'error', message: String(event.message) })
      worker.onmessage = event => {
        const data = event.data
        if (data.type === 'ready' || data.type === 'failed') { resolve(data); return }
        const settle = pending.get(data.id)
        pending.delete(data.id)
        settle?.({ type: data.type, code: data.code, logits: data.logits ? Array.from(data.logits) : undefined, ms: performance.now() - settle.started })
      }
    })
    worker.postMessage({ type: 'load', model, metadata, calibration, tokenizer, tokenizerConfig, threads, wasmBase: new URL('/ort/', location.href).href }, [model])
    const response = await answer
    return { response, loadMs: performance.now() - started }
  },
  score(prompt) {
    const id = next++
    return new Promise(resolve => {
      pending.set(id, resolve)
      resolve.started = performance.now()
      worker.postMessage({ type: 'score', id, prompt })
    })
  },
}
`

const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-validation-extension-'))
fs.cpSync(dist, copy, { recursive: true })
fs.mkdirSync(path.join(copy, 'model'))
for (const [stored, from] of Object.entries(EXPORT_PATHS)) {
  try { fs.linkSync(path.join(PATHS.model, from), path.join(copy, 'model', stored)) } catch { fs.copyFileSync(path.join(PATHS.model, from), path.join(copy, 'model', stored)) }
}
fs.writeFileSync(path.join(copy, 'bench.html'), '<!doctype html><meta charset="utf-8"><title>bench</title>')
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
})
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/bench.html`)
  await page.evaluate(HARNESS)
  if (!(await page.evaluate(() => (window as unknown as { harness: { isolated(): boolean } }).harness.isolated()))) throw new Error('not cross-origin isolated')
  const loaded = await page.evaluate(count => (window as any).harness.load(count), threads)
  if (loaded.response.type !== 'ready') throw new Error(JSON.stringify(loaded.response))
  console.error(`loaded in ${loaded.loadMs.toFixed(0)} ms`)
  fs.appendFileSync(path.resolve(PATHS.out, 'loads.jsonl'), JSON.stringify({ threads, loadMs: loaded.loadMs, at: new Date().toISOString(), load: os.loadavg() }) + '\n')
  const stream = fs.createWriteStream(out, { flags: 'a' })
  const started = Date.now()
  for (const [i, prompt] of prompts.entries()) {
    const answer = await page.evaluate(text => (window as any).harness.score(text), prompt.prompt) as { type: string; code?: string; logits?: number[]; ms: number }
    const logits = answer.logits ? [...answer.logits.slice(0, prompt.offered), answer.logits[format.nota_index]!] : undefined
    stream.write(JSON.stringify({ hash: prompt.hash, type: answer.type, code: answer.code, logits, ms: Math.round(answer.ms * 10) / 10, tokens: prompt.tokens, offered: prompt.offered, threads }) + '\n')
    if (i % 100 === 99) console.error(`${i + 1}/${prompts.length}, ${((Date.now() - started) / 60000).toFixed(1)} min, load ${os.loadavg()[0]!.toFixed(2)}`)
  }
  await new Promise(resolve => stream.end(resolve))
} finally {
  await context.close()
  fs.rmSync(copy, { recursive: true, force: true })
}
