import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  CodedError, DEFAULT_SETTINGS,
  type DictionaryResult, type Ranker, type RankerState, type RankerStatus, type Selection, type SenseFormat, type WorkerLike,
} from '../shared/contracts'
import { contextualOrder, isSenseFormat, senseRequest } from './prompt'

// Contextual meaning order for the definition card. One reusable worker holds
// the model. A lookup made before it is ready, or that the model cannot
// answer within the budget, gets dictionary order; nothing here ever fails a
// lookup. Text stays in this page and the worker; the cache keeps only
// prompt hashes and numbers. Ported from pdfpal's contextual-definitions.ts,
// on top of the WorkerLike contract instead of Node worker threads.

export interface SenseRankerOptions {
  /**
   * Starts a model worker that has already been sent its `load` message.
   * The ranker only listens for `ready` or `failed`. A thrown CodedError's
   * code becomes the failure code; any other error is WORKER_START_FAILED.
   */
  createWorker: () => WorkerLike | Promise<WorkerLike>
  /** How long a lookup waits for a ready model before dictionary order is used. */
  budgetMs?: number
  /** The most meanings offered to the model in one lookup. */
  maxCandidates?: number
  /** The pause before a failed model is loaded again. */
  retryMs?: number
  /** Loading (including `createWorker`) taking longer than this fails with LOAD_TIMEOUT. */
  loadTimeoutMs?: number
  /** A single prompt taking longer than this stops the worker (WORKER_TIMEOUT). */
  runTimeoutMs?: number
  /** How many late or past answers are kept, by prompt hash. */
  cacheSize?: number
  /** The worker is closed after this long without lookups, and loaded again on demand. 0 keeps it loaded. */
  idleMs?: number
}

export const RANKER_DEFAULTS = {
  budgetMs: DEFAULT_SETTINGS.budgetMs,
  maxCandidates: DEFAULT_SETTINGS.maxCandidates,
  retryMs: 60_000,
  loadTimeoutMs: 120_000,
  runTimeoutMs: 10_000,
  cacheSize: 64,
  idleMs: 10 * 60_000,
} as const

type Logits = ArrayLike<number>
type Job = { id: number; key: string; prompt: string; done: boolean; settle(logits: Logits | null): void }
type Timer = ReturnType<typeof setTimeout>

const encoder = new TextEncoder()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isLogits = (value: unknown): value is Logits => Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))
const codeOf = (error: unknown) => error instanceof CodedError ? error.code : 'WORKER_START_FAILED'

export class SenseRanker implements Ranker {
  readonly stats = { scored: 0, cached: 0, superseded: 0, timedOut: 0, skipped: 0, applied: 0, capped: 0, unloaded: 0 }
  private state: RankerState = 'idle'
  private code = ''
  private failedAt = Number.NEGATIVE_INFINITY
  /** Identifies the current load; callbacks of an older one are ignored. */
  private attempt = 0
  private worker: WorkerLike | undefined
  private format: SenseFormat | undefined
  private loadTimer: Timer | undefined
  private runTimer: Timer | undefined
  private idleTimer: Timer | undefined
  private inflight: Job | undefined
  private queued: Job | undefined
  private waiters: Array<() => void> = []
  private readonly cache = new Map<string, Logits>()
  private nextId = 1
  private budgetMs: number
  private maxCandidates: number
  private readonly retryMs: number
  private readonly loadTimeoutMs: number
  private readonly runTimeoutMs: number
  private readonly cacheSize: number
  private readonly idleMs: number

  constructor(private readonly options: SenseRankerOptions) {
    this.budgetMs = options.budgetMs ?? RANKER_DEFAULTS.budgetMs
    this.maxCandidates = options.maxCandidates ?? RANKER_DEFAULTS.maxCandidates
    this.retryMs = options.retryMs ?? RANKER_DEFAULTS.retryMs
    this.loadTimeoutMs = options.loadTimeoutMs ?? RANKER_DEFAULTS.loadTimeoutMs
    this.runTimeoutMs = options.runTimeoutMs ?? RANKER_DEFAULTS.runTimeoutMs
    this.cacheSize = options.cacheSize ?? RANKER_DEFAULTS.cacheSize
    this.idleMs = options.idleMs ?? RANKER_DEFAULTS.idleMs
  }

  /** Changes the budget and the cap for later lookups, for example after a settings change. */
  configure(patch: { budgetMs?: number; maxCandidates?: number }): void {
    if (patch.budgetMs !== undefined && Number.isFinite(patch.budgetMs) && patch.budgetMs >= 0) this.budgetMs = patch.budgetMs
    if (patch.maxCandidates !== undefined && Number.isFinite(patch.maxCandidates)) this.maxCandidates = patch.maxCandidates
  }

  status(): RankerStatus {
    return this.state === 'failed' ? { state: 'failed', code: this.code } : { state: this.state }
  }

  /** Resolves once the model is no longer loading. */
  settled(): Promise<RankerStatus> {
    if (this.state !== 'loading') return Promise.resolve(this.status())
    return new Promise(resolve => this.waiters.push(() => resolve(this.status())))
  }

  warm(): void {
    if (this.state === 'closed' || this.state === 'loading' || this.state === 'ready') return
    if (this.state === 'failed' && Date.now() - this.failedAt < this.retryMs) return
    this.state = 'loading'
    const attempt = ++this.attempt
    this.loadTimer = setTimeout(() => this.fail(attempt, 'LOAD_TIMEOUT'), this.loadTimeoutMs)
    this.armIdle()
    let created: WorkerLike | Promise<WorkerLike>
    try { created = this.options.createWorker() } catch (error) { this.fail(attempt, codeOf(error)); return }
    if ('then' in created && typeof created.then === 'function') created.then(worker => this.attach(attempt, worker), error => this.fail(attempt, codeOf(error)))
    else this.attach(attempt, created as WorkerLike)
  }

  /**
   * `result` with the meanings of each entry in contextual order, or `result`
   * itself whenever the model is not ready, the input is unsupported, the
   * model rejects every meaning, the budget runs out, `signal` aborts or
   * anything goes wrong.
   */
  async order(result: DictionaryResult, selection: Selection, signal?: AbortSignal): Promise<DictionaryResult> {
    try {
      if (signal?.aborted || this.state === 'closed') return result
      this.armIdle()
      const format = this.format
      if (this.state !== 'ready' || !format) { this.warm(); return result }
      const request = senseRequest(result, selection, format, this.maxCandidates)
      if ('skip' in request) { this.stats.skipped++; return result }
      if (request.candidates.length < request.total) this.stats.capped++
      const key = bytesToHex(sha256(encoder.encode(request.prompt)))
      let logits = this.cache.get(key)
      if (logits) {
        this.stats.cached++
        this.cache.delete(key); this.cache.set(key, logits)
      } else {
        logits = await this.score(key, request.prompt, signal) ?? undefined
        if (!logits) return result
      }
      const outcome = contextualOrder(result, request, logits, format)
      if (outcome.applied) this.stats.applied++
      return outcome.result
    } catch {
      return result
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    const worker = this.worker
    this.state = 'closed'
    this.reset()
    if (worker) stop(worker)
    this.notify()
  }

  private attach(attempt: number, worker: WorkerLike): void {
    // Created after a close, a timeout or a newer load: not wanted any more.
    if (attempt !== this.attempt || this.state !== 'loading') { stop(worker); return }
    this.worker = worker
    worker.addEventListener('message', event => this.receive(attempt, event?.data))
    worker.addEventListener('error', () => this.fail(attempt, 'WORKER_ERROR'))
  }

  private score(key: string, prompt: string, signal?: AbortSignal): Promise<Logits | null> {
    return new Promise(resolve => {
      const abort = () => { job.settle(null); if (this.queued === job) this.queued = undefined }
      const timer = setTimeout(() => { if (!job.done) this.stats.timedOut++; abort() }, this.budgetMs)
      const job: Job = {
        id: this.nextId++, key, prompt, done: false,
        settle: logits => {
          if (job.done) return
          job.done = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          resolve(logits)
        },
      }
      signal?.addEventListener('abort', abort, { once: true })
      // Only the newest lookup waits for the model; an older one still queued gets dictionary order now.
      if (this.queued) { this.stats.superseded++; this.queued.settle(null) }
      this.queued = job
      this.pump()
    })
  }

  private pump(): void {
    if (!this.worker || this.state !== 'ready' || this.inflight) return
    const job = this.queued
    this.queued = undefined
    if (!job || job.done) return
    this.inflight = job
    this.stats.scored++
    const attempt = this.attempt
    this.runTimer = setTimeout(() => this.fail(attempt, 'WORKER_TIMEOUT'), this.runTimeoutMs)
    try { this.worker.postMessage({ type: 'score', id: job.id, prompt: job.prompt }) } catch { this.fail(attempt, 'WORKER_ERROR') }
  }

  private receive(attempt: number, message: unknown): void {
    if (attempt !== this.attempt || !this.worker || !isRecord(message)) return
    if (message.type === 'ready') {
      if (this.state !== 'loading') return
      if (!isSenseFormat(message.format)) { this.fail(attempt, 'MODEL_FORMAT'); return }
      clearTimeout(this.loadTimer)
      this.format = message.format
      this.state = 'ready'
      this.notify()
    } else if (message.type === 'failed') {
      this.fail(attempt, typeof message.code === 'string' && message.code ? message.code : 'WORKER_FAILED')
    } else if ((message.type === 'scored' || message.type === 'rejected') && this.inflight && this.inflight.id === message.id) {
      clearTimeout(this.runTimer)
      const job = this.inflight
      this.inflight = undefined
      if (message.type === 'scored' && isLogits(message.logits)) {
        // A late answer still serves the same lookup next time.
        this.cache.set(job.key, message.logits)
        if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!)
        job.settle(message.logits)
      } else job.settle(null)
      this.pump()
    }
  }

  private fail(attempt: number, code: string): void {
    if (attempt !== this.attempt || (this.state !== 'loading' && this.state !== 'ready')) return
    const worker = this.worker
    this.state = 'failed'
    this.code = code
    this.failedAt = Date.now()
    this.reset()
    if (worker) stop(worker)
    this.notify()
  }

  private armIdle(): void {
    if (!(this.idleMs > 0) || !Number.isFinite(this.idleMs)) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.unloadIfIdle(), this.idleMs)
  }

  private unloadIfIdle(): void {
    this.idleTimer = undefined
    if (this.state === 'loading' || this.inflight || this.queued) { this.armIdle(); return }
    if (this.state !== 'ready') return
    const worker = this.worker
    this.reset()
    this.state = 'idle'
    this.stats.unloaded++
    if (worker) stop(worker)
  }

  private reset(): void {
    clearTimeout(this.loadTimer); clearTimeout(this.runTimer); clearTimeout(this.idleTimer)
    this.loadTimer = this.runTimer = this.idleTimer = undefined
    this.worker = undefined
    this.format = undefined
    const { inflight, queued } = this
    this.inflight = this.queued = undefined
    inflight?.settle(null); queued?.settle(null)
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

/** Asks a worker to release the model, then stops it. */
function stop(worker: WorkerLike): void {
  try { worker.postMessage({ type: 'close' }) } catch { /* already gone */ }
  try { worker.terminate() } catch { /* already gone */ }
}
