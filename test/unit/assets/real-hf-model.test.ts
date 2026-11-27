// Opt-in: downloads the five model files of the pinned Hugging Face revision
// (MODEL_SOURCE in scripts/assets-release.ts, the source the release script
// stages the model from) with the real fetch, hashing them as they stream,
// and checks each against the stored pins of the manifest. About 207 MB of
// transfer, nothing written to disk.
//
//   CD_TEST_REAL_ASSETS=1 npx vitest run test/unit/assets/real-hf-model.test.ts --silent=false
//
// Skipped otherwise; automated runs never touch the network.
import { describe, expect, test } from 'vitest'
import { ASSET_MANIFEST } from '../../../src/assets/manifest'
import { MODEL_EXPORT_PATHS, MODEL_SOURCE, hubFileUrl, verifyDownload } from '../../../scripts/assets-release'

describe.skipIf(process.env.CD_TEST_REAL_ASSETS !== '1')('the model at the pinned Hugging Face revision', () => {
  test('every model file the extension stores is byte for byte the published one', { timeout: 60 * 60_000 }, async () => {
    expect(MODEL_SOURCE.tag).toBe(ASSET_MANIFEST.tag)
    const results: Record<string, string> = {}
    for (const file of ASSET_MANIFEST.bundles.model) {
      const relative = MODEL_EXPORT_PATHS[file.storedName]
      expect(relative, file.storedName).toBeDefined()
      const url = hubFileUrl(MODEL_SOURCE, relative!)
      const result = await verifyDownload((input, init) => globalThis.fetch(input, init), url, { size: file.storedSize!, sha256: file.storedSha256! }, { attempts: 2 })
      expect(result, url).toMatchObject({ ok: true, size: file.storedSize, sha256: file.storedSha256 })
      results[relative!] = `${result.size} bytes in ${(result.ms / 1000).toFixed(1)} s`
    }
    console.log(`${MODEL_SOURCE.repo} at ${MODEL_SOURCE.revision}:`, results)
  })
})
