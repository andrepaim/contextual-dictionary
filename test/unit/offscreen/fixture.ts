// A small installable release for the offscreen host tests: the fixture pack
// as the dictionary and five stand-in model files under their real stored
// names, served by a mocked fetch, with a fake model worker.
import { STORED_NAMES, type AssetManifest } from '../../../src/assets/manifest'
import { MemoryFileStore } from '../../../src/assets/file-store'
import type { Fetch } from '../../../src/assets/download'
import { LocalAssetService } from '../../../src/assets/service'
import { openWiktionaryDictionary } from '../../../src/dict/lookup'
import { compareKeys } from '../../../src/dict/pack-format'
import { writePack } from '../../../src/dict/pack-writer'
import { OffscreenHost, type OffscreenHostOptions } from '../../../src/offscreen/host'
import { SenseRanker } from '../../../src/sense/ranker'
import { DEFAULT_SETTINGS, type BundleName, type Settings } from '../../../src/shared/contracts'
import { RECORDS } from '../../fixtures/dict/records'
import { BASE, bytes, gzipFile, identityFile, mockFetch, text } from '../assets/helpers'
import { FakeWorker, type FakeOptions } from '../sense/fake-worker'

export const MOUSE_SELECTION = { text: 'mouse', before: 'Drag the ', after: ' to move the cursor on screen.' }
export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch })

export async function hostFixture(fake: FakeOptions = {}, overrides: Partial<OffscreenHostOptions> = {}, extra: { fetch?: Fetch } = {}) {
  const pack = identityFile(STORED_NAMES.dictionary, await writePack([...RECORDS].sort((a, b) => compareKeys(a.k, b.k)), {
    meta: { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'fixture', snapshot: 'test' },
  }))
  const model = [
    gzipFile(`${STORED_NAMES.model}.gz`, STORED_NAMES.model, text(30_000, 'weights ')),
    identityFile(STORED_NAMES.modelMetadata, new TextEncoder().encode('{"template_version":"compact-v1"}')),
    identityFile(STORED_NAMES.calibration, new TextEncoder().encode('{"temperature":1}')),
    identityFile(STORED_NAMES.tokenizer, bytes(2000, 5)),
    identityFile(STORED_NAMES.tokenizerConfig, new TextEncoder().encode('{"mask_token":"[MASK]"}')),
  ]
  const manifest: AssetManifest = { tag: 'assets-test', baseUrl: BASE, bundles: { dictionary: [pack.file], model: model.map(item => item.file) } }
  const stored = new Map<BundleName, Array<[string, Uint8Array]>>([
    ['dictionary', [[pack.file.storedName, pack.transfer]]],
    ['model', [[model[0]!.file.storedName, text(30_000, 'weights ')], ...model.slice(1).map(item => [item.file.storedName, item.transfer] as [string, Uint8Array])]],
  ])
  const bodies = new Map([pack, ...model].map(({ file, transfer }) => [`${BASE}/assets-test/${file.name}`, transfer]))
  const network = mockFetch(bodies)
  const store = new MemoryFileStore()
  const assets = new LocalAssetService({ store, manifest, fetch: extra.fetch ?? network.fetch })
  const workers: FakeWorker[] = []
  const options = { fake: { ...fake } }
  const host = new OffscreenHost({
    assets,
    openDictionary: source => openWiktionaryDictionary(source),
    createRanker: rankerOptions => new SenseRanker({ ...rankerOptions, idleMs: 0, retryMs: 60_000 }),
    startWorker: () => { const worker = new FakeWorker(options.fake); workers.push(worker); return worker },
    threads: 4,
    wasmBase: 'chrome-extension://id/ort/',
    ...overrides,
  })
  /** Puts a bundle's files into the store as if downloaded earlier. */
  const install = (bundle: BundleName) => { for (const [name, data] of stored.get(bundle)!) store.files.set(name, data.slice()) }
  const sizeOf = (bundle: BundleName) => manifest.bundles[bundle].reduce((sum, file) => sum + (file.size ?? 0), 0)
  return { host, assets, store, network, workers, options, install, sizeOf, manifest }
}
