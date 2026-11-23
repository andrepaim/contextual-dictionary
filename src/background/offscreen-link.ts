// The service worker's line to the offscreen document: created on first real
// need, recreated when it was closed or crashed, and waited for while its
// script starts.
import { CodedError, type Settings } from '../shared/contracts'
import { unwrapReply } from '../shared/messaging'
import { offscreenMessage, type OffscreenMessage, type OffscreenRequest } from '../shared/offscreen-protocol'

/** The chrome.offscreen and chrome.runtime calls the link makes; tests pass a fake. */
export interface OffscreenApi {
  hasDocument(): Promise<boolean>
  createDocument(): Promise<void>
  sendMessage(message: OffscreenMessage): Promise<unknown>
}

export interface OffscreenLinkOptions {
  /** How many times a message that found no listener is sent again. */
  retries?: number
  retryDelayMs?: number
}

/** Chrome's wording when nothing listens (yet) or the document closed before answering. */
const NOT_LISTENING = /receiving end does not exist|message port closed|no response/i
const ALREADY_EXISTS = /single offscreen document/i
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const unavailable = () => new CodedError('OFFSCREEN_UNAVAILABLE', 'The extension’s background page is not available.')

export class OffscreenLink {
  readonly stats = { created: 0, retried: 0 }
  #creating: Promise<void> | undefined
  readonly #retries: number
  readonly #retryDelayMs: number

  constructor(private readonly api: OffscreenApi, options: OffscreenLinkOptions = {}) {
    this.#retries = options.retries ?? 40
    this.#retryDelayMs = options.retryDelayMs ?? 50
  }

  exists(): Promise<boolean> {
    return this.api.hasDocument()
  }

  /** Creates the document unless it exists; concurrent calls share one creation. */
  ensure(): Promise<void> {
    this.#creating ??= (async () => {
      try {
        if (await this.api.hasDocument()) return
        await this.api.createDocument()
        this.stats.created++
      } catch (error) {
        // Another context created it between the check and the call.
        if (!ALREADY_EXISTS.test(messageOf(error))) throw error
      } finally {
        this.#creating = undefined
      }
    })()
    return this.#creating
  }

  /**
   * Sends `request` with `settings` and returns the answer's value, or throws
   * its CodedError. Without `create`, a missing document is left alone and
   * the answer is undefined.
   */
  async call(request: OffscreenRequest, settings: Settings, options: { create: boolean }): Promise<unknown> {
    if (!options.create && !(await this.api.hasDocument())) return undefined
    const message = offscreenMessage(request, settings)
    for (let attempt = 0; ; attempt++) {
      let reply: unknown
      try {
        if (options.create) await this.ensure()
        reply = await this.api.sendMessage(message)
      } catch (error) {
        if (!NOT_LISTENING.test(messageOf(error))) throw unavailable()
        reply = undefined
      }
      if (reply !== undefined) return unwrapReply(reply)
      if (attempt >= this.#retries) throw unavailable()
      this.stats.retried++
      await new Promise(resolve => setTimeout(resolve, this.#retryDelayMs))
    }
  }
}
