// The service worker's message router. Every message is validated with
// isRequest and accepted only from this extension's own pages (the popup)
// and content scripts; content scripts may only ask for the status and look
// words up. Settings live in chrome.storage.local; everything that needs the
// dictionary, the downloads or the model goes to the offscreen document,
// which is created only when such a request arrives. A content script's
// status (every frame of every page asks once) is answered from storage
// alone.
import { CodedError, REQUEST_TYPES, isRequest, type BundleStatus, type Reply, type Request, type RequestType, type Settings, type Status } from '../shared/contracts'
import { errorReply, type SenderLike } from '../shared/messaging'
import { OFFSCREEN_TARGET, isRuntimeStatus, type OffscreenRequest, type RuntimeStatus } from '../shared/offscreen-protocol'
import { isSiteEnabled } from '../shared/settings'

const UNKNOWN_BUNDLE: BundleStatus = { phase: 'missing', error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 0 }
/** What a content script is told about bundles and the model before anything is known; it acts on the settings only. */
export const UNKNOWN_RUNTIME: RuntimeStatus = { bundles: { dictionary: UNKNOWN_BUNDLE, model: UNKNOWN_BUNDLE }, ranker: { state: 'idle' } }

export interface RouterOptions {
  settings: {
    get(): Promise<Settings>
    patch(patch: Partial<Omit<Settings, 'disabledSites'>>): Promise<Settings>
    setSite(host: string, enabled: boolean): Promise<Settings>
  }
  offscreen: { call(request: OffscreenRequest, settings: Settings, options: { create: boolean }): Promise<unknown> }
  cache: { get(): Promise<RuntimeStatus | undefined>; set(status: RuntimeStatus): Promise<void> }
  extensionId: string
  /** chrome.runtime.getURL(''), ending in a slash. */
  extensionOrigin: string
}

type Caller = 'page' | 'content'
const CONTENT_REQUESTS: ReadonlySet<RequestType> = new Set(['status', 'define', 'cancel-define'])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export class Router {
  /** Requests handled, by type. Counts only; never content. */
  readonly stats = Object.fromEntries(REQUEST_TYPES.map(type => [type, 0])) as Record<RequestType, number>

  constructor(private readonly options: RouterOptions) {}

  /** The reply to `message`, or undefined when the message is not for the router. */
  handle(message: unknown, sender: SenderLike): Promise<Reply<unknown>> | undefined {
    const caller = this.#caller(sender)
    if (!caller || (isRecord(message) && message.target === OFFSCREEN_TARGET)) return undefined
    if (!isRequest(message)) return Promise.resolve({ ok: false, code: 'BAD_REQUEST', message: 'This request is not understood.' })
    if (caller === 'content' && !CONTENT_REQUESTS.has(message.type)) return Promise.resolve({ ok: false, code: 'FORBIDDEN', message: 'Pages cannot make this request.' })
    this.stats[message.type]++
    return this.#answer(message, caller).then(value => ({ ok: true as const, value }), errorReply)
  }

  #caller(sender: SenderLike): Caller | undefined {
    if (sender.id !== this.options.extensionId || typeof sender.url !== 'string') return undefined
    // The popup, also when opened in a tab.
    if (sender.url.startsWith(this.options.extensionOrigin)) return 'page'
    if (sender.tab) return 'content'
    return undefined
  }

  async #answer(request: Request, caller: Caller): Promise<unknown> {
    const { settings: store, offscreen } = this.options
    switch (request.type) {
      case 'status': {
        const settings = await store.get()
        const runtime = caller === 'page' ? await this.#runtime({ type: 'status' }, settings) : (await this.options.cache.get()) ?? UNKNOWN_RUNTIME
        return this.#status(settings, request.host, runtime)
      }
      case 'set-settings': {
        const settings = await store.patch(request.patch)
        return this.#status(settings, request.host, await this.#runtime({ type: 'settings' }, settings))
      }
      case 'set-site': {
        const settings = await store.setSite(request.host, request.enabled)
        return this.#status(settings, request.host, await this.#runtime({ type: 'status' }, settings))
      }
      case 'define': {
        const settings = await store.get()
        if (!settings.definitions) throw new CodedError('DEFINITIONS_OFF', 'Definitions are switched off.')
        return offscreen.call({ type: 'define', requestId: request.requestId, selection: request.selection }, settings, { create: true })
      }
      case 'cancel-define':
        await offscreen.call({ type: 'cancel-define', requestId: request.requestId }, await store.get(), { create: false })
        return null
      case 'download':
      case 'cancel-download':
      case 'remove-assets': {
        const settings = await store.get()
        const forwarded: OffscreenRequest = request.type === 'download'
          ? { type: 'download', bundle: request.bundle, acceptBytes: request.acceptBytes }
          : { type: request.type, bundle: request.bundle }
        return this.#status(settings, request.host, await this.#runtime(forwarded, settings))
      }
    }
  }

  /** Asks the offscreen document (creating it) and remembers the answer for content scripts. */
  async #runtime(request: OffscreenRequest, settings: Settings): Promise<RuntimeStatus> {
    const runtime = await this.options.offscreen.call(request, settings, { create: true })
    if (!isRuntimeStatus(runtime)) throw new CodedError('NO_RESPONSE', 'No status from the extension’s background page.')
    await this.options.cache.set(runtime)
    return runtime
  }

  #status(settings: Settings, host: string | undefined, runtime: RuntimeStatus): Status {
    return { settings, siteEnabled: isSiteEnabled(settings, host), bundles: runtime.bundles, ranker: runtime.ranker }
  }
}
