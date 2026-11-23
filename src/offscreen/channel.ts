// The offscreen document's chrome.runtime listener: it answers only the
// messages the service worker forwards to it, and leaves every other message
// (pages and content scripts also reach this document) to the service worker.
import { normalizeSettings, type Settings } from '../shared/contracts'
import { errorReply, type Handler } from '../shared/messaging'
import { isOffscreenMessage, type OffscreenRequest } from '../shared/offscreen-protocol'

export interface OffscreenHandlerOptions {
  extensionId: string
  /** chrome.runtime.getURL('service-worker.js') */
  serviceWorkerUrl: string
}

export function offscreenHandler(host: { handle(request: OffscreenRequest, settings: Settings): Promise<unknown> }, options: OffscreenHandlerOptions): Handler {
  return (message, sender) => {
    if (!isOffscreenMessage(message) || sender.id !== options.extensionId || sender.tab || sender.url !== options.serviceWorkerUrl) return undefined
    return host.handle(message.request, normalizeSettings(message.settings)).then(value => ({ ok: true, value }), errorReply)
  }
}
