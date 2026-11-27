// Types and message shapes shared by every module. Modules depend on these
// interfaces, never on each other's internals, so they can be built and
// tested apart. Change this file only by a small, separate pull request.

import { MIN_SENSE_CANDIDATES, SELECTION_LIMITS, SENSE_PROMPT_DEFAULTS, type ByteSource, type DictionaryResult, type Selection, type SenseFormat } from '@andrepaim/contextual-dictionary-core'

export { CodedError, SELECTION_LIMITS } from '@andrepaim/contextual-dictionary-core'
export type { ByteSource, Dictionary, DictionaryEntry, DictionaryResult, DictionarySense, DictionarySource, Selection, SenseFormat } from '@andrepaim/contextual-dictionary-core'

// --------------------------------------------------------------------- bytes

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>
  /** Puts the finished file in place under its final name. */
  commit(): Promise<void>
  /** Discards everything written. */
  abort(): Promise<void>
}

/** Files of the extension's private storage. A file exists only once committed. */
export interface FileStore {
  open(name: string): Promise<ByteSource | undefined>
  create(name: string): Promise<FileWriter>
  remove(name: string): Promise<void>
  list(): Promise<Array<{ name: string; size: number }>>
}

// --------------------------------------------------------------------- model

/** What the model worker needs to load. Buffers are transferred, not copied. */
export interface ModelLoad {
  type: 'load'
  model: ArrayBuffer
  tokenizer: string
  tokenizerConfig: string
  metadata: string
  calibration: string
  threads: number
  /** The extension URL of the directory holding the ONNX Runtime WebAssembly files. */
  wasmBase: string
}

export type WorkerRequest = ModelLoad | { type: 'score'; id: number; prompt: string } | { type: 'close' }

export type WorkerResponse =
  | { type: 'ready'; format: SenseFormat }
  | { type: 'failed'; code: string }
  | { type: 'scored'; id: number; logits: Float32Array }
  | { type: 'rejected'; id: number; code: string }

/** The part of a Web Worker the ranker uses; tests substitute a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: WorkerResponse }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  terminate(): void
}

export type RankerState = 'idle' | 'loading' | 'ready' | 'failed' | 'closed'
export type RankerStatus = { state: Exclude<RankerState, 'failed'> } | { state: 'failed'; code: string }

/**
 * What the context model did to the order of a lookup's meanings. Numbers and
 * one status word only: no text, no score.
 */
export type OrderStatus = 'ordered' | 'off' | 'no-model' | 'loading' | 'timed-out' | 'nothing-to-order' | 'not-english' | 'none-fits' | 'unavailable'
export const ORDER_STATUSES: readonly OrderStatus[] = ['ordered', 'off', 'no-model', 'loading', 'timed-out', 'nothing-to-order', 'not-english', 'none-fits', 'unavailable']

export interface OrderDetails {
  status: OrderStatus
  /**
   * Only with status 'ordered'. positions[e][i] is the 0-based dictionary
   * position of result.entries[e].senses[i], the meaning now at place i.
   */
  positions?: number[][]
  /**
   * Only with status 'ordered'. offered[e] is how many meanings of entry e
   * the model was offered; they are the first offered[e] of the answer's
   * senses. The rest follow in dictionary order.
   */
  offered?: number[]
  /**
   * Only with status 'ordered'. entryPositions[e] is the 0-based dictionary
   * position of result.entries[e]; the identity unless the entry holding the
   * model's best meaning moved first.
   */
  entryPositions?: number[]
}

export interface Ranker {
  status(): RankerStatus
  /** Starts loading the model in the background, unless it is loaded, loading, closed or recently failed. */
  warm(): void
  /** `result` with each entry's meanings in contextual order (and the entry holding the best one first), or `result` itself on any problem, with what was done. Never rejects. */
  rank(result: DictionaryResult, selection: Selection, signal?: AbortSignal): Promise<{ result: DictionaryResult; details: OrderDetails }>
  /** `rank()`'s result alone. */
  order(result: DictionaryResult, selection: Selection, signal?: AbortSignal): Promise<DictionaryResult>
  close(): Promise<void>
}

// -------------------------------------------------------------------- assets

export type BundleName = 'dictionary' | 'model'
export type BundlePhase = 'missing' | 'downloading' | 'installing' | 'ready' | 'failed'

export interface BundleStatus {
  phase: BundlePhase
  /** A code such as DOWNLOAD_FAILED; null when there is no problem. */
  error: string | null
  /** Bytes a download would transfer now; 0 when everything is installed. */
  requiredBytes: number
  receivedBytes: number
  totalBytes: number
  /** Bytes this bundle occupies in the extension's storage. */
  storedBytes: number
}

export interface AssetService {
  status(): Promise<Record<BundleName, BundleStatus>>
  /** Starts the download the reader confirmed. `acceptBytes` must equal the size shown. */
  startDownload(bundle: BundleName, acceptBytes: number): Promise<void>
  cancel(bundle: BundleName): Promise<void>
  remove(bundle: BundleName): Promise<void>
  /** A verified installed file by its stored name, or undefined. */
  open(storedName: string): Promise<ByteSource | undefined>
}

// ------------------------------------------------------- settings and status

export interface Settings {
  /** Show definition cards. */
  definitions: boolean
  /** List each entry's meanings by contextual fit. */
  orderByContext: boolean
  /** Show in the card what the context model did to the order (docs/order-details-plan.md). */
  showOrderDetails: boolean
  /** Host names where the extension stays silent. */
  disabledSites: string[]
  /** How long a lookup waits for a ready model, in milliseconds. */
  budgetMs: number
  /** The most meanings offered to the model in one lookup. */
  maxCandidates: number
}

// Chosen from the stage 3 measurements (docs/validation.md): model order beat
// dictionary order clearly, so ordering is on (the model is still downloaded
// only after the reader confirms it); with the ranker's prompt length limit a
// 750 ms budget answers every lookup of the evaluation set on 8 and 4 threads.
// Order details are off, so the card looks as it did in 0.1.0.
export const DEFAULT_SETTINGS: Settings = { definitions: true, orderByContext: true, showOrderDetails: false, disabledSites: [], budgetMs: 750, maxCandidates: SENSE_PROMPT_DEFAULTS.maxCandidates }
export const SETTING_LIMITS = { budgetMs: { min: 50, max: 2000 }, maxCandidates: { min: MIN_SENSE_CANDIDATES, max: 127 } } as const

export interface Status {
  settings: Settings
  /** Whether the extension is active on the asking page's host. */
  siteEnabled: boolean
  bundles: Record<BundleName, BundleStatus>
  ranker: RankerStatus
}

export interface DefineAnswer {
  result: DictionaryResult
  /** Whether the model's order was applied (`order.status === 'ordered'`). */
  ordered: boolean
  /** What the model did to the order; sent whatever the settings, shown only with "Show order details". */
  order?: OrderDetails
}

// ------------------------------------------------------------------ messages

// `host` on a request answered with a Status names the asking page, so the
// answer's `siteEnabled` is for that page; without it the answer says enabled.
export type Request =
  | { type: 'define'; requestId: string; selection: Selection }
  | { type: 'cancel-define'; requestId: string }
  | { type: 'status'; host?: string }
  | { type: 'set-settings'; patch: Partial<Omit<Settings, 'disabledSites'>>; host?: string }
  | { type: 'set-site'; host: string; enabled: boolean }
  | { type: 'download'; bundle: BundleName; acceptBytes: number; host?: string }
  | { type: 'cancel-download'; bundle: BundleName; host?: string }
  | { type: 'remove-assets'; bundle: BundleName; host?: string }

export type RequestType = Request['type']
export const REQUEST_TYPES: readonly RequestType[] = ['define', 'cancel-define', 'status', 'set-settings', 'set-site', 'download', 'cancel-download', 'remove-assets']

/** What each request answers with. */
export interface Answers {
  define: DefineAnswer
  'cancel-define': null
  status: Status
  'set-settings': Status
  'set-site': Status
  download: Status
  'cancel-download': Status
  'remove-assets': Status
}

export type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string; details?: Record<string, unknown> }

/** How pages reach the extension's back end; rejects with a CodedError. */
export interface Backend {
  send<T extends Request>(request: T, signal?: AbortSignal): Promise<Answers[T['type']]>
}

const BUNDLES: readonly string[] = ['dictionary', 'model']
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

/** Whether `value` is a well-formed request; messages from pages are untrusted. */
export function isRequest(value: unknown): value is Request {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type !== 'set-site' && value.host !== undefined && !isText(value.host, 255)) return false
  switch (value.type) {
    case 'define': {
      const selection = value.selection
      return isText(value.requestId, 64) && value.requestId.length > 0 && isRecord(selection)
        && isText(selection.text, SELECTION_LIMITS.definableChars * 2) && selection.text.trim().length > 0
        && isText(selection.before, SELECTION_LIMITS.contextChars * 2) && isText(selection.after, SELECTION_LIMITS.contextChars * 2)
    }
    case 'cancel-define': return isText(value.requestId, 64) && value.requestId.length > 0
    case 'status': return true
    case 'set-settings': {
      const patch = value.patch
      if (!isRecord(patch)) return false
      const allowed = ['definitions', 'orderByContext', 'showOrderDetails', 'budgetMs', 'maxCandidates']
      if (Object.keys(patch).some(key => !allowed.includes(key))) return false
      for (const key of ['definitions', 'orderByContext', 'showOrderDetails']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') return false
      for (const key of ['budgetMs', 'maxCandidates']) if (patch[key] !== undefined && !Number.isFinite(patch[key])) return false
      return true
    }
    case 'set-site': return isText(value.host, 255) && value.host.length > 0 && typeof value.enabled === 'boolean'
    case 'download': return BUNDLES.includes(value.bundle as string) && Number.isSafeInteger(value.acceptBytes) && (value.acceptBytes as number) >= 0
    case 'cancel-download':
    case 'remove-assets': return BUNDLES.includes(value.bundle as string)
    default: return false
  }
}

/** `settings` with numbers kept inside their limits and unknown keys dropped. */
export function normalizeSettings(settings: Partial<Settings> | undefined): Settings {
  const clamp = (value: unknown, fallback: number, { min, max }: { min: number; max: number }) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
  const sites = Array.isArray(settings?.disabledSites) ? settings.disabledSites.filter((site): site is string => typeof site === 'string' && site.length > 0 && site.length <= 255) : []
  return {
    definitions: typeof settings?.definitions === 'boolean' ? settings.definitions : DEFAULT_SETTINGS.definitions,
    orderByContext: typeof settings?.orderByContext === 'boolean' ? settings.orderByContext : DEFAULT_SETTINGS.orderByContext,
    showOrderDetails: typeof settings?.showOrderDetails === 'boolean' ? settings.showOrderDetails : DEFAULT_SETTINGS.showOrderDetails,
    disabledSites: [...new Set(sites.map(site => site.toLowerCase()))].sort(),
    budgetMs: clamp(settings?.budgetMs, DEFAULT_SETTINGS.budgetMs, SETTING_LIMITS.budgetMs),
    maxCandidates: clamp(settings?.maxCandidates, DEFAULT_SETTINGS.maxCandidates, SETTING_LIMITS.maxCandidates),
  }
}
