// The extension's service worker: settings, message routing and the
// offscreen document's lifecycle. Wiring only; the logic is in router.ts,
// settings-store.ts and offscreen-link.ts (docs/plan.md section 5.6). Chrome
// may stop this worker at any moment, so it holds no model, download or cache.
import { messageListener } from '../shared/messaging'
import { OffscreenLink } from './offscreen-link'
import { Router } from './router'
import { RuntimeStatusCache, SettingsStore } from './settings-store'

const OFFSCREEN_PAGE = 'offscreen.html'
const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PAGE)

const link = new OffscreenLink({
  hasDocument: async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [offscreenUrl] })).length > 0,
  createDocument: () => chrome.offscreen.createDocument({
    url: OFFSCREEN_PAGE,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Runs the dictionary and the local word-sense model in a Web Worker, and keeps the downloaded files.',
  }),
  sendMessage: message => chrome.runtime.sendMessage(message),
})

const router = new Router({
  settings: new SettingsStore(chrome.storage.local),
  offscreen: link,
  cache: new RuntimeStatusCache(chrome.storage.session),
  extensionId: chrome.runtime.id,
  extensionOrigin: chrome.runtime.getURL(''),
})

chrome.runtime.onMessage.addListener(messageListener((message, sender) => router.handle(message, sender)))

// Request counts for the end-to-end tests and for debugging; numbers only.
Object.assign(globalThis, { contextualDictionary: { requests: router.stats, offscreen: link.stats } })
