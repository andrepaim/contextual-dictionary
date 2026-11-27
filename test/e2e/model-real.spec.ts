import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test, type Page } from '@playwright/test'
import { Tokenizer } from '@huggingface/tokenizers'
import { MODEL_FILES } from '../../src/model/load'
import type { SenseFormat } from '../../src/shared/contracts'
import { EXTENSION_DIR, launchExtension } from './helpers'

// Runs the real Ettin-150m-WSD INT8 checkpoint with the built model worker
// (dist/model-worker.js and dist/ort/) inside Chromium, on a cross-origin
// isolated test page so WebAssembly threads work. Opt in with the directory
// of a model export with the shipped model revision, for example the one
// `node scripts/publish-assets.mjs --dry-run` downloads from Hugging Face:
//
//   CD_TEST_MODEL_DIR=~/.cache/contextual-dictionary/hf-models/andrepaim/Ettin-150m-WSD-wiktionary/0edcbab04bb30eadeeef6babb26e8055b173b8d7 npm run test:e2e -- model-real
//
// CD_TEST_MODEL_BENCH=1 also measures load time and warm latency by number of
// candidates, with 8, 4 and 1 threads, and prints a table (docs/model-runtime.md).
// CD_TEST_MODEL_BENCH_THREADS=8,2 and CD_TEST_MODEL_ONNX=onnx/model.onnx change what is measured.
const directory = process.env.CD_TEST_MODEL_DIR?.replace(/^~(?=\/)/, process.env.HOME ?? '~')
const bench = process.env.CD_TEST_MODEL_BENCH === '1'
/** For comparisons only: another ONNX file of the export (for example onnx/model.onnx) and other thread counts. */
const onnxFile = process.env.CD_TEST_MODEL_ONNX ?? 'onnx/model.int8.onnx'
const benchThreads = (process.env.CD_TEST_MODEL_BENCH_THREADS ?? '8,4,1').split(',').map(Number)

/** Where each stored file comes from in a sense-model export. */
const EXPORT_PATHS: Record<string, string> = {
  [MODEL_FILES.model]: onnxFile,
  [MODEL_FILES.metadata]: 'model_metadata.json',
  [MODEL_FILES.calibration]: 'calibration.json',
  [MODEL_FILES.tokenizer]: 'tokenizer.json',
  [MODEL_FILES.tokenizerConfig]: 'tokenizer_config.json',
}

/** Page code that drives the built worker; it reads /model-worker.js, /ort/ and /model/<stored name> from its own origin. */
const HARNESS = `
const FILES = ${JSON.stringify(MODEL_FILES)}
let worker, next = 1
const pending = new Map()

window.harness = {
  isolated: () => crossOriginIsolated,
  async load(threads) {
    worker?.terminate()
    const started = performance.now()
    const bytes = name => fetch('/model/' + name).then(response => response.arrayBuffer())
    const text = name => fetch('/model/' + name).then(response => response.text())
    const [model, metadata, calibration, tokenizer, tokenizerConfig] = await Promise.all([
      bytes(FILES.model), text(FILES.metadata), text(FILES.calibration), text(FILES.tokenizer), text(FILES.tokenizerConfig),
    ])
    const fetched = performance.now()
    worker = new Worker('/model-worker.js', { type: 'module' })
    const answer = new Promise(resolve => {
      worker.onerror = event => resolve({ type: 'error', message: String(event.message) })
      worker.onmessage = event => {
        const data = event.data
        if (data.type === 'ready' || data.type === 'failed') { resolve(data); return }
        const settle = pending.get(data.id)
        pending.delete(data.id)
        settle?.({ ...data, logits: data.logits ? Array.from(data.logits) : undefined, ms: performance.now() - settle.started })
      }
    })
    worker.postMessage({ type: 'load', model, metadata, calibration, tokenizer, tokenizerConfig, threads, wasmBase: new URL('/ort/', location.href).href }, [model])
    const response = await answer
    return { response, fetchMs: fetched - started, loadMs: performance.now() - fetched, transferred: model.byteLength === 0 }
  },
  score(prompt) {
    const id = next++
    return new Promise(resolve => {
      resolve.started = performance.now()
      pending.set(id, resolve)
      worker.postMessage({ type: 'score', id, prompt })
    })
  },
  async memory() {
    try { return (await performance.measureUserAgentSpecificMemory()).bytes } catch { return null }
  },
  close() { worker?.postMessage({ type: 'close' }) },
}
window.harnessReady = true
`
const PAGE = `<!doctype html><meta charset="utf-8"><title>model check</title><script type="module">${HARNESS}</script>`

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }
const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' }

/** The test page, the built worker and runtime, and the model files, with cross-origin isolation headers. */
async function serve(modelDirectory: string) {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    let file: string | undefined
    if (name === '/') { response.writeHead(200, { ...ISOLATION, 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return }
    if (name === '/model-worker.js') file = path.join(EXTENSION_DIR, 'model-worker.js')
    else if (name.startsWith('/ort/') && !name.includes('..')) file = path.join(EXTENSION_DIR, name)
    else if (name.startsWith('/model/') && EXPORT_PATHS[name.slice(7)]) file = path.join(modelDirectory, EXPORT_PATHS[name.slice(7)]!)
    if (!file || !fs.existsSync(file)) { response.writeHead(404, ISOLATION).end(); return }
    response.writeHead(200, { ...ISOLATION, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': fs.statSync(file).size })
    fs.createReadStream(file).pipe(response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

interface Harness {
  isolated(): boolean
  load(threads: number): Promise<{ response: { type: string; format?: SenseFormat; code?: string; message?: string }; fetchMs: number; loadMs: number; transferred: boolean }>
  score(prompt: string): Promise<{ type: string; id: number; logits?: number[]; code?: string; ms: number }>
  memory(): Promise<number | null>
  close(): void
}
declare global { interface Window { harness: Harness; harnessReady: boolean } }

/** A compact-v1 prompt, as `senseRequest` in src/sense builds it. */
function prompt(format: SenseFormat, before: string, target: string, after: string, definitions: string[]): string {
  const choices = definitions.map((definition, i) => `${format.letters[i]}. ${definition}`)
  choices.push(`${format.letters[format.nota_index]}. ${format.none_text}`)
  return `${before}*${target}*${after}\n${choices.join('\n')}\n${format.separator} ${format.mask_token}`
}

const best = (logits: number[], count: number, format: SenseFormat) => {
  const choices = [...logits.slice(0, count).map((value, i) => ({ value, i })), { value: logits[format.nota_index]!, i: format.nota_index }]
  return choices.reduce((a, b) => (b.value > a.value ? b : a)).i
}

const MOUSE = [
  'Any small rodent of the genus Mus.',
  'A quiet or shy person.',
  'An input device that is moved over a pad or other flat surface to produce a corresponding movement of a pointer on a graphical display.',
  'A black eye.',
]
const BANK = [
  'An institution where one can place and borrow money and take care of financial affairs.',
  'The edge of a river, lake, or other watercourse.',
  'An elevation, or rise, of the sea floor.',
  'A supply of something held in reserve.',
]

/** Wiktionary-length meanings of "run", cycled to reach the larger inventories. */
const RUN = [
  'To move swiftly on foot so that both feet leave the ground during each stride.',
  'To go at a fast pace, to move quickly.',
  'To compete in a race.',
  'To carry out an activity, to manage or be in charge of something.',
  'To be a candidate in an election.',
  'Of a fluid, to flow.',
  'Of a machine or engine, to be in operation.',
  'To execute or carry out a plan, procedure or program.',
  'To extend or persist, statically or dynamically, through space or time.',
  'Of a bus, train or other vehicle, to make a regular trip along a route.',
  'To publish or broadcast something, such as a story in a newspaper.',
  'To smuggle illegal goods across a border.',
  'Of stitches or stitching, to unravel or come undone.',
  'Of colours in a fabric, to bleed or spread when wet.',
  'To cost a certain amount of money.',
  'To tend or become, often in a negative way.',
  'To pass a rope through a block or eye.',
  'To drive or force something into a particular position or state.',
  'To cause an animal to move swiftly, especially in a race or a hunt.',
  'Act or instance of running, of moving rapidly using the feet.',
  'A regular trip or route travelled by a vehicle.',
  'A continuous series of performances of a play or show.',
  'A sudden series of demands on a bank by people withdrawing their money.',
  'A point scored in cricket or baseball by running between the bases or wickets.',
  'A pen or enclosure in which animals such as chickens are kept.',
]
const inventory = (count: number) => Array.from({ length: count }, (_, i) => RUN[i % RUN.length]!)

async function open(page: Page, url: string) {
  await page.goto(url)
  await page.waitForFunction(() => window.harnessReady === true)
  expect(await page.evaluate(() => window.harness.isolated()), 'the test page is cross-origin isolated').toBe(true)
}

test.describe('the real checkpoint under WebAssembly', () => {
  test.skip(!directory, 'set CD_TEST_MODEL_DIR to a local Ettin-150m-WSD export')
  test.setTimeout(900_000)

  test('orders "mouse" and "bank" by context in Chromium with threads', async () => {
    const server = await serve(directory!)
    const browser = await chromium.launch({ channel: 'chromium', headless: true })
    try {
      const page = await browser.newPage()
      const warnings: string[] = []
      page.on('console', message => { if (/thread|isolat/i.test(message.text())) warnings.push(message.text()) })
      await open(page, server.url)
      const { response, transferred, fetchMs, loadMs } = await page.evaluate(() => window.harness.load(8))
      expect(response, JSON.stringify(response)).toMatchObject({ type: 'ready' })
      expect(transferred, 'the model buffer is transferred, not copied').toBe(true)
      const format = response.format!
      expect(format.letters).toHaveLength(128)
      console.log(`real model: fetch ${fetchMs.toFixed(0)} ms, load to ready ${loadMs.toFixed(0)} ms (8 threads)`)

      const score = async (text: string, count: number) => {
        const answer = await page.evaluate(value => window.harness.score(value), text)
        expect(answer.type, JSON.stringify({ type: answer.type, code: answer.code })).toBe('scored')
        expect(answer.logits).toHaveLength(128)
        return best(answer.logits!, count, format)
      }
      expect(await score(prompt(format, 'Drag the ', 'mouse', ' to move the cursor on screen', MOUSE), MOUSE.length), 'pointing device first').toBe(2)
      expect(await score(prompt(format, 'The children sat on the grassy ', 'bank', ' of the river and watched the boats go by.', BANK), BANK.length), 'river bank first').toBe(1)
      expect(await score(prompt(format, 'After the meeting he walked over and deposited his salary at the ', 'bank', ' before it closed for the day.', BANK), BANK.length), 'financial institution first').toBe(0)

      const tooLong = await page.evaluate(value => window.harness.score(value), prompt(format, '', 'run', ' run'.repeat(2100), RUN))
      expect(tooLong).toMatchObject({ type: 'rejected', code: 'TOO_LONG' })
      expect(warnings, 'ONNX Runtime did not fall back to one thread').toEqual([])
      await page.evaluate(() => window.harness.close())
    } finally {
      await browser.close()
      await server.close()
    }
  })

  test('loads and runs the real model with the built worker inside the extension', async () => {
    // A throwaway copy of dist/ with the model files beside it, so the worker
    // runs under the extension's own CSP and cross-origin isolation.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-model-extension-'))
    try {
      fs.cpSync(EXTENSION_DIR, copy, { recursive: true })
      fs.mkdirSync(path.join(copy, 'model'))
      for (const [stored, from] of Object.entries(EXPORT_PATHS)) {
        try { fs.linkSync(path.join(directory!, from), path.join(copy, 'model', stored)) } catch { fs.copyFileSync(path.join(directory!, from), path.join(copy, 'model', stored)) }
      }
      const { context, extensionId } = await launchExtension(copy)
      try {
        const page = await context.newPage()
        await page.goto(`chrome-extension://${extensionId}/popup.html`)
        await page.evaluate(HARNESS)
        expect(await page.evaluate(() => window.harness.isolated()), 'extension pages are cross-origin isolated').toBe(true)
        const { response, loadMs } = await page.evaluate(() => window.harness.load(8))
        expect(response, JSON.stringify(response)).toMatchObject({ type: 'ready' })
        const workerIsolated = await page.workers()[0]?.evaluate(() => crossOriginIsolated)
        expect(workerIsolated, 'the model worker is cross-origin isolated').toBe(true)
        console.log(`real model in the extension: load to ready ${loadMs.toFixed(0)} ms (8 threads)`)
        const format = response.format!
        const answer = await page.evaluate(value => window.harness.score(value), prompt(format, 'Drag the ', 'mouse', ' to move the cursor on screen', MOUSE))
        expect(answer.type).toBe('scored')
        expect(best(answer.logits!, MOUSE.length, format), 'pointing device first').toBe(2)
        await page.evaluate(() => window.harness.close())
      } finally {
        await context.close()
      }
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  test('measures load time and warm latency by number of candidates', async () => {
    test.skip(!bench, 'set CD_TEST_MODEL_BENCH=1 to measure')
    const tokenizer = new Tokenizer(
      JSON.parse(fs.readFileSync(path.join(directory!, 'tokenizer.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(directory!, 'tokenizer_config.json'), 'utf8')),
    )
    const server = await serve(directory!)
    const browser = await chromium.launch({ channel: 'chromium', headless: true })
    const rows: string[] = [], loads: string[] = []
    try {
      for (const threads of benchThreads) {
        const page = await browser.newPage()
        await open(page, server.url)
        const { response, fetchMs, loadMs } = await page.evaluate(count => window.harness.load(count), threads)
        expect(response.type).toBe('ready')
        const format = response.format!
        const memory = await page.evaluate(() => window.harness.memory())
        loads.push(`threads ${threads}: fetch ${fetchMs.toFixed(0)} ms, load to ready ${loadMs.toFixed(0)} ms${memory ? `, memory ${(memory / 1e6).toFixed(0)} MB` : ''}`)
        for (const count of [6, 12, 24, 48, 100]) {
          const text = prompt(format, 'She decided to ', 'run', ' the old program again before the meeting started.', inventory(count))
          const tokens = tokenizer.encode(text).ids.length
          const runs = threads === 1 && count >= 48 ? 3 : 7
          const times: number[] = []
          await page.evaluate(value => window.harness.score(value), text)
          for (let i = 0; i < runs; i++) {
            const answer = await page.evaluate(value => window.harness.score(value), text)
            expect(answer.type).toBe('scored')
            times.push(answer.ms)
          }
          times.sort((a, b) => a - b)
          rows.push(`| ${threads} | ${count} | ${tokens} | ${times[Math.floor(times.length / 2)]!.toFixed(0)} | ${times[0]!.toFixed(0)}–${times.at(-1)!.toFixed(0)} | ${runs} |`)
        }
        await page.close()
      }
      console.log([...loads, '', '| Threads | Candidates | Tokens | Median ms | Range ms | Runs |', '| ---: | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n'))
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
