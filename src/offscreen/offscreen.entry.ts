// The long-lived offscreen document: assets, dictionary, ranker and the
// model worker. Wiring only; the logic is in host.ts and channel.ts
// (docs/plan.md section 5.6). The listener is registered before anything
// else, so the service worker's first message is never missed.
import { OpfsFileStore } from '../assets/file-store'
import { LocalAssetService } from '../assets/service'
import { openWiktionaryDictionary } from '../dict/lookup'
import { defaultThreads } from '../model/load'
import { SenseRanker } from '../sense/ranker'
import { CodedError, type WorkerLike } from '../shared/contracts'
import { messageListener } from '../shared/messaging'
import { offscreenHandler } from './channel'
import { loadEnvironment } from './environment'
import { OffscreenHost } from './host'

const host = (async () => {
  const environment = await loadEnvironment(path => chrome.runtime.getURL(path))
  // This document owns the downloads, so it alone removes leftovers of interrupted writes.
  const store = await OpfsFileStore.open({ cleanup: true })
  return new OffscreenHost({
    assets: new LocalAssetService({ store, manifest: environment.manifest }),
    openDictionary: source => openWiktionaryDictionary(source),
    createRanker: options => new SenseRanker(options),
    startWorker: () => new Worker(environment.workerUrl, { type: 'module' }) as unknown as WorkerLike,
    threads: defaultThreads(),
    wasmBase: environment.wasmBase,
  })
})()
const ready = host.catch(() => { throw new CodedError('STORAGE_UNAVAILABLE', 'The extension’s private storage could not be opened.') })
ready.catch(() => {})

chrome.runtime.onMessage.addListener(messageListener(offscreenHandler(
  { handle: async (request, settings) => (await ready).handle(request, settings) },
  { extensionId: chrome.runtime.id, serviceWorkerUrl: chrome.runtime.getURL('service-worker.js') },
)))
