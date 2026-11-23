// The offscreen document's work: the asset service, the dictionary, the
// ranker and its model worker. Requests arrive from the service worker with
// the current settings, which are applied first. Lookups fail open: any
// problem while ordering leaves dictionary order.
import { STORED_NAMES } from '../assets/manifest'
import { readModelLoad } from '../model/load'
import {
  CodedError, DEFAULT_SETTINGS,
  type AssetService, type BundleName, type ByteSource, type DefineAnswer, type Dictionary, type Ranker, type RankerStatus, type Selection, type Settings, type WorkerLike,
} from '../shared/contracts'
import type { OffscreenRequest, RuntimeStatus } from '../shared/offscreen-protocol'

export interface AssetsLike extends AssetService {
  verify(bundle: BundleName): Promise<boolean>
  settled(bundle: BundleName): Promise<void>
  /** Hears of a file that a background check found damaged (and removed). */
  onInvalid(listener: (bundle: BundleName) => void): () => void
  /** Resolves once the background checks started so far have finished. */
  checked(): Promise<void>
}

export interface RankerLike extends Ranker {
  configure(patch: { budgetMs?: number; maxCandidates?: number }): void
  settled(): Promise<RankerStatus>
}

export interface OffscreenHostOptions {
  assets: AssetsLike
  openDictionary(source: ByteSource): Promise<Dictionary>
  createRanker(options: { createWorker: () => Promise<WorkerLike>; budgetMs: number; maxCandidates: number }): RankerLike
  /** A new model worker, not yet sent `load`. */
  startWorker(): WorkerLike
  threads: number
  /** The extension URL of the ONNX Runtime files. */
  wasmBase: string
}

/** Load failures that a damaged or missing file can cause; after one, the model files are hashed again. */
const RECHECK_CODES = new Set(['MODEL_MISMATCH', 'SESSION_FAILED', 'LOAD_FAILED', 'MODEL_MISSING', 'MODEL_FORMAT'])

export class OffscreenHost {
  #settings: Settings | undefined
  #ranker: RankerLike
  #dictionary: Promise<Dictionary> | undefined
  readonly #lookups = new Map<string, AbortController>()
  readonly #tasks = new Set<Promise<unknown>>()
  readonly #watched = new WeakSet<RankerLike>()

  constructor(private readonly options: OffscreenHostOptions) {
    this.#ranker = this.#newRanker()
    // Files are hashed in the background after their first open in a session; one that fails is gone, so let go of it.
    options.assets.onInvalid(bundle => this.#invalidated(bundle))
  }

  async handle(request: OffscreenRequest, settings: Settings): Promise<unknown> {
    this.#apply(settings)
    const { assets } = this.options
    switch (request.type) {
      case 'status':
      case 'settings':
        return this.#status()
      case 'define':
        return this.#define(request.requestId, request.selection)
      case 'cancel-define':
        this.#lookups.get(request.requestId)?.abort()
        return null
      case 'download':
        await assets.startDownload(request.bundle, request.acceptBytes)
        this.#track(assets.settled(request.bundle).then(() => this.#installed(request.bundle)))
        return this.#status()
      case 'cancel-download':
        await assets.cancel(request.bundle)
        return this.#status()
      case 'remove-assets':
        if (request.bundle === 'model') this.#replaceRanker()
        this.#dictionary = request.bundle === 'dictionary' ? undefined : this.#dictionary
        await assets.remove(request.bundle)
        return this.#status()
    }
  }

  /** Resolves once background work (installs, model loads, checks) has finished; for tests. */
  async idle(): Promise<void> {
    do {
      while (this.#tasks.size) await Promise.allSettled([...this.#tasks])
      await this.options.assets.checked()
    } while (this.#tasks.size)
  }

  // ----------------------------------------------------------------- settings

  #apply(settings: Settings): void {
    const previous = this.#settings
    this.#settings = settings
    this.#ranker.configure({ budgetMs: settings.budgetMs, maxCandidates: settings.maxCandidates })
    if (settings.orderByContext && !previous?.orderByContext) this.#track(this.#warmIfInstalled())
    else if (!settings.orderByContext && previous?.orderByContext) this.#replaceRanker()
  }

  async #status(): Promise<RuntimeStatus> {
    return { bundles: await this.options.assets.status(), ranker: this.#ranker.status() }
  }

  // ------------------------------------------------------------------ lookups

  async #define(requestId: string, selection: Selection): Promise<DefineAnswer> {
    const controller = new AbortController()
    this.#lookups.get(requestId)?.abort()
    this.#lookups.set(requestId, controller)
    try {
      const result = await (await this.#openDictionary()).define(selection)
      if (!result.entries.length || !this.#settings?.orderByContext || controller.signal.aborted) return { result, ordered: false }
      try {
        const ranker = this.#ranker
        if (ranker.status().state !== 'ready' && !(await this.#modelInstalled())) return { result, ordered: false }
        const ordered = await ranker.order(result, selection, controller.signal)
        this.#watch(ranker)
        return { result: ordered, ordered: ordered !== result }
      } catch {
        return { result, ordered: false }
      }
    } finally {
      if (this.#lookups.get(requestId) === controller) this.#lookups.delete(requestId)
    }
  }

  #openDictionary(): Promise<Dictionary> {
    if (this.#dictionary) return this.#dictionary
    const opening = (async () => {
      const source = await this.options.assets.open(STORED_NAMES.dictionary)
      if (!source) throw new CodedError('DICTIONARY_MISSING', 'The dictionary is not installed.')
      return this.options.openDictionary(source)
    })()
    this.#dictionary = opening
    // A failure is not kept: the next lookup tries again.
    opening.catch(() => { if (this.#dictionary === opening) this.#dictionary = undefined })
    return opening
  }

  // -------------------------------------------------------------------- model

  #newRanker(): RankerLike {
    const settings = this.#settings ?? DEFAULT_SETTINGS
    return this.options.createRanker({ createWorker: () => this.#createWorker(), budgetMs: settings.budgetMs, maxCandidates: settings.maxCandidates })
  }

  /** Closes the current ranker (and its worker) and puts an idle one in its place. */
  #replaceRanker(): void {
    const old = this.#ranker
    this.#ranker = this.#newRanker()
    void old.close()
  }

  async #createWorker(): Promise<WorkerLike> {
    const { message, transfer } = await readModelLoad(name => this.options.assets.open(name), { threads: this.options.threads, wasmBase: this.options.wasmBase })
    const worker = this.options.startWorker()
    worker.postMessage(message, transfer)
    return worker
  }

  async #modelInstalled(): Promise<boolean> {
    return (await this.options.assets.status()).model.phase === 'ready'
  }

  async #warmIfInstalled(): Promise<void> {
    if (!this.#settings?.orderByContext || !(await this.#modelInstalled()) || !this.#settings.orderByContext) return
    const ranker = this.#ranker
    ranker.warm()
    this.#watch(ranker)
  }

  /** After a load that failed in a way a damaged file explains, hashes the model files again; a removed file shows the model as missing. */
  #watch(ranker: RankerLike): void {
    if (ranker.status().state !== 'loading' || this.#watched.has(ranker)) return
    this.#watched.add(ranker)
    this.#track(ranker.settled().then(async status => {
      this.#watched.delete(ranker)
      if (status.state !== 'failed' || !RECHECK_CODES.has(status.code) || ranker !== this.#ranker) return
      const intact = await this.options.assets.verify('model')
      // A fresh ranker loads at once after the next download instead of waiting out the retry pause.
      if (!intact && ranker === this.#ranker) this.#replaceRanker()
    }))
  }

  /** A background check removed a damaged file of `bundle`: the open dictionary or the loaded model is dropped. */
  #invalidated(bundle: BundleName): void {
    if (bundle === 'dictionary') this.#dictionary = undefined
    else this.#replaceRanker()
  }

  async #installed(bundle: BundleName): Promise<void> {
    if ((await this.options.assets.status())[bundle].phase !== 'ready') return
    if (bundle === 'dictionary') { this.#dictionary = undefined; return }
    this.#replaceRanker()
    await this.#warmIfInstalled()
  }

  #track(work: Promise<unknown>): void {
    const task: Promise<unknown> = work.catch(() => undefined).finally(() => this.#tasks.delete(task))
    this.#tasks.add(task)
  }
}
