import { describe, expect, test } from 'vitest'
import { CodedError } from '../../../src/shared/contracts'
import { ASSET_MANIFEST, STORED_NAMES, assertManifest, fileUrl, isPinned, manifestProblems, publishedFiles, type AssetManifest } from '../../../src/assets/manifest'
import { fixture } from './helpers'

const clone = (manifest: AssetManifest): AssetManifest => structuredClone(manifest)

describe('the pinned manifest', () => {
  test('is valid and names the release of this repository', () => {
    expect(manifestProblems(ASSET_MANIFEST)).toEqual([])
    expect(ASSET_MANIFEST.tag).toBe('assets-v1')
    expect(ASSET_MANIFEST.baseUrl).toBe('https://github.com/andrepaim/contextual-dictionary/releases/download')
  })

  test('pins the stored form of the five model files from the Ettin INT8 export', () => {
    const model = ASSET_MANIFEST.bundles.model
    expect(model.map(file => file.storedName)).toEqual(['ettin-150m-wsd-int8.onnx', 'model_metadata.json', 'calibration.json', 'tokenizer.json', 'tokenizer_config.json'])
    const onnx = model[0]!
    expect(onnx).toMatchObject({ name: 'ettin-150m-wsd-int8.onnx.gz', encoding: 'gzip', storedSize: 266954889, storedSha256: '8649a1139b81a56b16ec6853d6127882a1b9539a4c33c09e3fce93ab62822d68' })
    expect(model.find(file => file.storedName === 'tokenizer.json')).toMatchObject({ storedSize: 3583228, storedSha256: '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30' })
    expect(model.find(file => file.storedName === 'model_metadata.json')).toMatchObject({ storedSize: 1552, storedSha256: '7a07cdd82572cada84061c1cdb61670b2d220d9cc422397d18244874d9fb7707' })
    expect(model.find(file => file.storedName === 'calibration.json')).toMatchObject({ storedSize: 101, storedSha256: '84f67365897b09a6d6b7d2289f16dd6582d07e7e6e0f1b2094491a72b636d8ab' })
    expect(model.find(file => file.storedName === 'tokenizer_config.json')).toMatchObject({ storedSize: 487, storedSha256: 'd0ec2c8141eec0fa98e31a43c3a453f9c40dcde862762762b0f1898bfb793183' })
  })

  test('names the dictionary pack and exports every stored name', () => {
    expect(ASSET_MANIFEST.bundles.dictionary.map(file => file.storedName)).toEqual(['wiktionary-en-v1.pack'])
    expect(Object.values(STORED_NAMES).sort()).toEqual([...ASSET_MANIFEST.bundles.dictionary, ...ASSET_MANIFEST.bundles.model].map(file => file.storedName).sort())
  })

  test('is fully pinned with the published release, so both bundles can be downloaded', () => {
    const files = [...ASSET_MANIFEST.bundles.dictionary, ...ASSET_MANIFEST.bundles.model]
    for (const file of files) expect(isPinned(file), file.name).toBe(true)
    expect(assertManifest(ASSET_MANIFEST)).toBe(ASSET_MANIFEST)
    expect(publishedFiles(ASSET_MANIFEST, 'dictionary')).toHaveLength(1)
    expect(publishedFiles(ASSET_MANIFEST, 'model')).toHaveLength(5)
    // The pack built from the Kaikki extract of 2026-10-30 (docs/dictionary-build.md), sent as is.
    expect(ASSET_MANIFEST.bundles.dictionary[0]).toEqual({
      name: 'wiktionary-en-v1.pack', storedName: 'wiktionary-en-v1.pack', encoding: 'identity',
      size: 66467698, sha256: 'e698a7117d4a684d554c1c5850674ed9035c2daab7dbd8125c6c63758b6e6c32',
      storedSize: 66467698, storedSha256: 'e698a7117d4a684d554c1c5850674ed9035c2daab7dbd8125c6c63758b6e6c32',
    })
    // Files sent as is have equal transfer and stored pins; the gzipped model is smaller than the graph.
    for (const file of files.filter(entry => entry.encoding === 'identity')) expect([file.size, file.sha256], file.name).toEqual([file.storedSize, file.storedSha256])
    const onnx = ASSET_MANIFEST.bundles.model[0]!
    expect(onnx.size!).toBeLessThan(onnx.storedSize!)
    expect(onnx.sha256).not.toBe(onnx.storedSha256)
  })
})

describe('publishedFiles and fileUrl', () => {
  test('return the pinned files of a published bundle and their release URLs', () => {
    const { manifest } = fixture()
    expect(publishedFiles(manifest, 'model')).toHaveLength(3)
    expect(fileUrl(manifest, manifest.bundles.dictionary[0]!)).toBe('https://assets.test/releases/download/assets-test/wiktionary-test.pack')
  })

  test('treat a bundle with one unpinned file as unpublished', () => {
    const manifest = clone(fixture().manifest)
    manifest.bundles.model[1] = { ...manifest.bundles.model[1]!, size: null, sha256: null }
    expect(manifestProblems(manifest)).toEqual([])
    expect(publishedFiles(manifest, 'model')).toBeUndefined()
    expect(publishedFiles(manifest, 'dictionary')).toHaveLength(1)
  })
})

describe('manifestProblems', () => {
  const problems = (change: (manifest: AssetManifest) => void) => {
    const manifest = clone(fixture().manifest)
    change(manifest)
    return manifestProblems(manifest)
  }
  const file = (manifest: AssetManifest) => manifest.bundles.dictionary[0]!

  test('accepts the fixture and a loopback http base for local test servers', () => {
    expect(problems(() => {})).toEqual([])
    expect(problems(manifest => { manifest.baseUrl = 'http://127.0.0.1:8123/files' })).toEqual([])
    expect(problems(manifest => { manifest.baseUrl = 'http://localhost:8123' })).toEqual([])
  })

  test('refuses values that are not manifests', () => {
    for (const value of [null, undefined, 7, 'x', [], {}]) expect(manifestProblems(value).length).toBeGreaterThan(0)
    expect(problems(manifest => { (manifest as { bundles: unknown }).bundles = null })).not.toEqual([])
    expect(problems(manifest => { (manifest.bundles as Record<string, unknown>).model = 'files' })).not.toEqual([])
    expect(problems(manifest => { manifest.bundles.model = [] })).not.toEqual([])
    expect(problems(manifest => { (manifest.bundles as Record<string, unknown>).extra = [] })).not.toEqual([])
    expect(problems(manifest => { (manifest.bundles.model as unknown[])[0] = null })).not.toEqual([])
  })

  test('refuses an unsafe tag or a base URL that is not https (or loopback http)', () => {
    for (const tag of ['', '../x', 'a/b', '.hidden', 'a b', 'x'.repeat(200)]) expect(problems(manifest => { manifest.tag = tag }), tag).not.toEqual([])
    for (const base of ['', 'not a url', 'http://example.org/x', 'ftp://example.org', 'https://example.org/x?y=1', 'https://example.org/x/', 'https://user:pw@example.org']) {
      expect(problems(manifest => { manifest.baseUrl = base }), base).not.toEqual([])
    }
  })

  test('refuses unsafe names, sizes that are not positive integers and digests that are not 64 hex digits', () => {
    for (const name of ['', '.tmp', '../x', 'a/b', 'a\\b', 'a:b', 7]) {
      expect(problems(manifest => { (file(manifest) as { name: unknown }).name = name }), String(name)).not.toEqual([])
      expect(problems(manifest => { (file(manifest) as { storedName: unknown }).storedName = name }), String(name)).not.toEqual([])
    }
    for (const size of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '10']) {
      expect(problems(manifest => { (file(manifest) as { size: unknown }).size = size; (file(manifest) as { storedSize: unknown }).storedSize = size }), String(size)).not.toEqual([])
    }
    for (const digest of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63), 7]) {
      expect(problems(manifest => { (file(manifest) as { sha256: unknown }).sha256 = digest; (file(manifest) as { storedSha256: unknown }).storedSha256 = digest }), String(digest)).not.toEqual([])
    }
    expect(problems(manifest => { (file(manifest) as { encoding: unknown }).encoding = 'br' })).not.toEqual([])
  })

  test('refuses half-pinned files, transfer pins without stored pins, and identity files whose two forms differ', () => {
    expect(problems(manifest => { file(manifest).size = null })).not.toEqual([])
    expect(problems(manifest => { file(manifest).storedSha256 = null })).not.toEqual([])
    expect(problems(manifest => { file(manifest).storedSize = null; file(manifest).storedSha256 = null })).not.toEqual([])
    expect(problems(manifest => { file(manifest).size = file(manifest).size! + 1 })).not.toEqual([])
    expect(problems(manifest => { file(manifest).sha256 = 'f'.repeat(64) })).not.toEqual([])
    expect(problems(manifest => { file(manifest).name = 'other.pack' })).not.toEqual([])
    // Not yet published at all: allowed.
    expect(problems(manifest => { Object.assign(file(manifest), { size: null, sha256: null, storedSize: null, storedSha256: null }) })).toEqual([])
  })

  test('refuses a stored or published name used twice', () => {
    expect(problems(manifest => { manifest.bundles.model[2] = { ...manifest.bundles.model[2]!, storedName: 'model.onnx' } })).not.toEqual([])
    expect(problems(manifest => { manifest.bundles.model[2] = { ...manifest.bundles.model[0]!, storedName: 'other.onnx' } })).not.toEqual([])
  })

  test('assertManifest returns a valid manifest and throws a coded error otherwise', () => {
    const { manifest } = fixture()
    expect(assertManifest(manifest)).toBe(manifest)
    expect(() => assertManifest({})).toThrow(CodedError)
    try { assertManifest({}) } catch (error) { expect((error as CodedError).code).toBe('MANIFEST_INVALID') }
  })
})
