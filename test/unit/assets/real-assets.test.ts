// Opt-in: downloads every published file of the pinned release through the
// asset service with the real fetch, into memory, and checks both bundles
// end up ready and verified. About 214 MB of transfer and 337 MB of memory.
//
//   CD_TEST_REAL_ASSETS=1 npx vitest run test/unit/assets/real-assets.test.ts --silent=false
//
// Skipped otherwise; automated runs never touch the network.
import { describe, expect, test } from 'vitest'
import { MemoryFileStore } from '../../../src/assets/file-store'
import { ASSET_MANIFEST, BUNDLE_NAMES } from '../../../src/assets/manifest'
import { LocalAssetService } from '../../../src/assets/service'
import { sha } from './helpers'

describe.skipIf(process.env.CD_TEST_REAL_ASSETS !== '1')('the published assets', () => {
  test('download into a memory store, match their pins and leave both bundles ready', { timeout: 60 * 60_000 }, async () => {
    const store = new MemoryFileStore()
    const service = new LocalAssetService({ store, stallMs: 120_000 })
    const before = await service.status()
    const timings: Record<string, string> = {}
    for (const bundle of BUNDLE_NAMES) {
      expect(before[bundle]).toMatchObject({ phase: 'missing', error: null })
      const started = performance.now()
      await service.startDownload(bundle, before[bundle].requiredBytes)
      await service.settled(bundle)
      const seconds = (performance.now() - started) / 1000
      timings[bundle] = `${(before[bundle].requiredBytes / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)} s (${(before[bundle].requiredBytes / 1e6 / seconds).toFixed(1)} MB/s)`
    }
    const after = await service.status()
    for (const bundle of BUNDLE_NAMES) expect(after[bundle], bundle).toMatchObject({ phase: 'ready', error: null, requiredBytes: 0 })
    for (const bundle of BUNDLE_NAMES) {
      for (const file of ASSET_MANIFEST.bundles[bundle]) {
        const stored = store.files.get(file.storedName)
        expect(stored?.length, file.storedName).toBe(file.storedSize)
        expect(sha(stored!), file.storedName).toBe(file.storedSha256)
      }
      expect(await service.verify(bundle)).toBe(true)
    }
    console.log('Downloaded the published assets:', timings)
  })
})
