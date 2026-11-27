// Tests of the logic behind scripts/publish-assets.mjs, on small fixture
// files in a temporary directory. No network: `gh` and `fetch` are fakes.
import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { STORED_NAMES, assertManifest, publishedFiles, type AssetManifest } from '../../../src/assets/manifest'
import { ASSET_MANIFEST } from '../../../src/assets/manifest'
import {
  MODEL_EXPORT_PATHS, MODEL_SOURCE, NOTICE_NAMES, ReleaseError, defaultHubCache, digestFile, downloadHubModel, gunzipDigest, gzipFile, hubFileUrl, hubModelDir, hubSource, main,
  parseOptions, pinnedManifest, publishRelease, releaseExists, releaseNotes, releaseTitle, releaseUrl, repoOf, stageRelease, traceRedirects,
  verifyDownload, formatPins,
  type HubSource, type Run, type StagedFile,
} from '../../../scripts/assets-release'
import { sha, text } from './helpers'

const BASE = 'https://github.com/owner/repo/releases/download'
const temps: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cd-publish-assets-test-'))
  temps.push(dir)
  return dir
}
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true }))) })

const CONTENT: Record<string, Uint8Array> = {
  'onnx/model.int8.onnx': text(50_000, 'weights '),
  'model_metadata.json': new TextEncoder().encode('{"template_version":"compact-v1"}\n'),
  'calibration.json': new TextEncoder().encode('{"temperature":1.0}\n'),
  'tokenizer.json': text(4_000, 'token '),
  'tokenizer_config.json': new TextEncoder().encode('{"mask_token":"[MASK]"}\n'),
}
const PACK = text(30_000, 'CDPK block ')
const NOTICE_TEXT: Record<string, string> = { 'NOTICES-model.txt': 'model notices\n', 'NOTICES-dictionary.txt': 'dictionary notices\n' }

/** A model export, a pack, notices and a manifest shaped like the unpublished one: stored model pins only. */
async function inputs() {
  const dir = await tempDir()
  const modelDir = path.join(dir, 'export')
  await fsp.mkdir(path.join(modelDir, 'onnx'), { recursive: true })
  for (const [name, data] of Object.entries(CONTENT)) await fsp.writeFile(path.join(modelDir, name), data)
  const packPath = path.join(dir, 'wiktionary-en-v1.pack')
  await fsp.writeFile(packPath, PACK)
  const noticesDir = path.join(dir, 'notices')
  await fsp.mkdir(noticesDir)
  for (const [name, value] of Object.entries(NOTICE_TEXT)) await fsp.writeFile(path.join(noticesDir, name), value)
  const stored = (file: string) => ({ storedSize: CONTENT[file]!.length, storedSha256: sha(CONTENT[file]!) })
  const manifest: AssetManifest = {
    tag: 'assets-v1',
    baseUrl: BASE,
    bundles: {
      dictionary: [{ name: STORED_NAMES.dictionary, size: null, sha256: null, storedName: STORED_NAMES.dictionary, storedSize: null, storedSha256: null, encoding: 'identity' }],
      model: [
        { name: 'ettin-150m-wsd-int8.onnx.gz', size: null, sha256: null, storedName: STORED_NAMES.model, ...stored('onnx/model.int8.onnx'), encoding: 'gzip' },
        { name: 'model_metadata.json', size: null, sha256: null, storedName: STORED_NAMES.modelMetadata, ...stored('model_metadata.json'), encoding: 'identity' },
        { name: 'calibration.json', size: null, sha256: null, storedName: STORED_NAMES.calibration, ...stored('calibration.json'), encoding: 'identity' },
        { name: 'tokenizer.json', size: null, sha256: null, storedName: STORED_NAMES.tokenizer, ...stored('tokenizer.json'), encoding: 'identity' },
        { name: 'tokenizer_config.json', size: null, sha256: null, storedName: STORED_NAMES.tokenizerConfig, ...stored('tokenizer_config.json'), encoding: 'identity' },
      ],
    },
  }
  assertManifest(manifest)
  const out = path.join(dir, 'staged')
  await fsp.mkdir(out)
  return { dir, modelDir, packPath, noticesDir, manifest, out, release: { modelDir, packPath, noticesDir, pack: { size: PACK.length, sha256: sha(PACK) } } }
}

const RELEASE_NAMES = ['wiktionary-en-v1.pack', 'ettin-150m-wsd-int8.onnx.gz', 'model_metadata.json', 'calibration.json', 'tokenizer.json', 'tokenizer_config.json', 'NOTICES-model.txt', 'NOTICES-dictionary.txt']

async function staged() {
  const setup = await inputs()
  const files = await stageRelease(setup.manifest, setup.release, setup.out)
  return { ...setup, files }
}

describe('digests and gzip', () => {
  test('digestFile returns the size and SHA-256 of a file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'a.bin')
    await fsp.writeFile(file, CONTENT['tokenizer.json']!)
    expect(await digestFile(file)).toEqual({ size: 4000, sha256: sha(CONTENT['tokenizer.json']!) })
  })

  test('gzipFile is deterministic: no name, no time, a fixed OS byte, and it gunzips to the input', async () => {
    const dir = await tempDir()
    const source = path.join(dir, 'model.onnx')
    await fsp.writeFile(source, CONTENT['onnx/model.int8.onnx']!)
    const first = await gzipFile(source, path.join(dir, 'one.gz'))
    const second = await gzipFile(source, path.join(dir, 'two.gz'))
    const bytes = await fsp.readFile(path.join(dir, 'one.gz'))
    expect(first).toEqual(second)
    expect(first).toEqual({ size: bytes.length, sha256: sha(bytes) })
    expect(sha(await fsp.readFile(path.join(dir, 'two.gz')))).toBe(first.sha256)
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0x1f, 0x8b, 8])
    expect(bytes[3]).toBe(0) // no FNAME, FCOMMENT, FEXTRA or FHCRC
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 0])
    expect(bytes[8]).toBe(2) // maximum compression
    expect(bytes[9]).toBe(255)
    expect(new Uint8Array(gunzipSync(bytes))).toEqual(CONTENT['onnx/model.int8.onnx'])
    expect(await gunzipDigest(path.join(dir, 'one.gz'))).toEqual({ size: 50_000, sha256: sha(CONTENT['onnx/model.int8.onnx']!) })
  })

  test('gzipFile never overwrites an existing file', async () => {
    const dir = await tempDir()
    const source = path.join(dir, 'model.onnx')
    await fsp.writeFile(source, 'x')
    await fsp.writeFile(path.join(dir, 'taken.gz'), 'old')
    await expect(gzipFile(source, path.join(dir, 'taken.gz'))).rejects.toThrow()
    expect(await fsp.readFile(path.join(dir, 'taken.gz'), 'utf8')).toBe('old')
  })
})

describe('stageRelease', () => {
  test('stages the gzipped model, the small model files, the pack and the notices with their pins', async () => {
    const { files, out } = await staged()
    expect(files.map(file => file.name)).toEqual(RELEASE_NAMES)
    expect(fs.readdirSync(out).sort()).toEqual([...RELEASE_NAMES].sort())
    for (const file of files) {
      const bytes = await fsp.readFile(file.path)
      expect(file.path).toBe(path.join(out, file.name))
      expect({ size: file.size, sha256: file.sha256 }).toEqual({ size: bytes.length, sha256: sha(bytes) })
    }
    const onnx = files.find(file => file.name === 'ettin-150m-wsd-int8.onnx.gz')!
    expect(onnx).toMatchObject({ kind: 'model', encoding: 'gzip', stored: { name: STORED_NAMES.model, size: 50_000, sha256: sha(CONTENT['onnx/model.int8.onnx']!) } })
    expect(onnx.size).toBeLessThan(50_000)
    expect(new Uint8Array(gunzipSync(await fsp.readFile(onnx.path)))).toEqual(CONTENT['onnx/model.int8.onnx'])
    const pack = files.find(file => file.name === 'wiktionary-en-v1.pack')!
    expect(pack).toMatchObject({ kind: 'dictionary', encoding: 'identity', size: PACK.length, sha256: sha(PACK), stored: { name: STORED_NAMES.dictionary, size: PACK.length, sha256: sha(PACK) } })
    expect(files.find(file => file.name === 'tokenizer.json')).toMatchObject({ kind: 'model', size: 4000, sha256: sha(CONTENT['tokenizer.json']!) })
    expect(files.find(file => file.name === 'NOTICES-model.txt')).toMatchObject({ kind: 'notice', size: NOTICE_TEXT['NOTICES-model.txt']!.length })
    expect(NOTICE_NAMES).toEqual(['NOTICES-model.txt', 'NOTICES-dictionary.txt'])
  })

  test('two runs stage byte-identical files', async () => {
    const setup = await inputs()
    const first = await stageRelease(setup.manifest, setup.release, setup.out)
    const again = path.join(setup.dir, 'again')
    await fsp.mkdir(again)
    const second = await stageRelease(setup.manifest, setup.release, again)
    expect(second.map(({ name, size, sha256 }) => ({ name, size, sha256 }))).toEqual(first.map(({ name, size, sha256 }) => ({ name, size, sha256 })))
  })

  const refusal = async (change: (setup: Awaited<ReturnType<typeof inputs>>) => Promise<void> | void) => {
    const setup = await inputs()
    await change(setup)
    try {
      await stageRelease(setup.manifest, setup.release, setup.out)
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseError)
      return (error as ReleaseError).problems.join('\n')
    }
    throw new Error('stageRelease did not refuse')
  }

  test('refuses a model file that differs from its stored pin, and stages nothing', async () => {
    const problems = await refusal(async ({ modelDir }) => { await fsp.appendFile(path.join(modelDir, 'tokenizer.json'), 'x') })
    expect(problems).toContain('tokenizer.json')
    expect(problems).toContain('4001')
  })

  test('refuses a missing input, a pack that differs from its expected hash, and a missing notice', async () => {
    expect(await refusal(async ({ modelDir }) => { await fsp.rm(path.join(modelDir, 'onnx/model.int8.onnx')) })).toContain('model.int8.onnx')
    expect(await refusal(({ release }) => { release.pack = { size: PACK.length, sha256: 'f'.repeat(64) } })).toContain('wiktionary-en-v1.pack')
    expect(await refusal(async ({ noticesDir }) => { await fsp.rm(path.join(noticesDir, 'NOTICES-dictionary.txt')) })).toContain('NOTICES-dictionary.txt')
    expect(await refusal(async ({ noticesDir }) => { await fsp.writeFile(path.join(noticesDir, 'NOTICES-model.txt'), '') })).toContain('NOTICES-model.txt')
  })

  test('refuses a manifest whose model files have no stored pins, or files it has no source for', async () => {
    expect(await refusal(({ manifest }) => { Object.assign(manifest.bundles.model[2]!, { storedSize: null, storedSha256: null }) })).toContain('calibration.json')
    expect(await refusal(({ manifest }) => { manifest.bundles.model[2] = { ...manifest.bundles.model[2]!, name: 'extra.json', storedName: 'extra.json' } })).toContain('extra.json')
  })

  test('refuses a pack whose stored pins in the manifest differ from the expected pack', async () => {
    const problems = await refusal(({ manifest }) => { Object.assign(manifest.bundles.dictionary[0]!, { storedSize: 5, storedSha256: 'a'.repeat(64) }) })
    expect(problems).toContain('wiktionary-en-v1.pack')
  })

  test('refuses staged files that differ from transfer pins already in the manifest, and accepts matching ones', async () => {
    const setup = await inputs()
    const files = await stageRelease(setup.manifest, setup.release, setup.out)
    const pinned = pinnedManifest(setup.manifest, files)
    const again = path.join(setup.dir, 'again')
    await fsp.mkdir(again)
    await expect(stageRelease(pinned, setup.release, again)).resolves.toHaveLength(8)
    pinned.bundles.model[0] = { ...pinned.bundles.model[0]!, size: 12, sha256: 'b'.repeat(64) }
    const third = path.join(setup.dir, 'third')
    await fsp.mkdir(third)
    await expect(stageRelease(pinned, setup.release, third)).rejects.toMatchObject({ problems: [expect.stringContaining('ettin-150m-wsd-int8.onnx.gz')] })
  })

  test('refuses to stage into a directory that already holds a release file', async () => {
    const setup = await inputs()
    await fsp.writeFile(path.join(setup.out, 'calibration.json'), 'old')
    await expect(stageRelease(setup.manifest, setup.release, setup.out)).rejects.toThrow()
    expect(await fsp.readFile(path.join(setup.out, 'calibration.json'), 'utf8')).toBe('old')
  })
})

describe('pins and notes', () => {
  test('pinnedManifest fills every pin, so both bundles count as published', async () => {
    const { manifest, files } = await staged()
    const pinned = pinnedManifest(manifest, files)
    expect(assertManifest(pinned)).toBe(pinned)
    expect(publishedFiles(pinned, 'dictionary')).toHaveLength(1)
    expect(publishedFiles(pinned, 'model')).toHaveLength(5)
    expect(pinned.bundles.dictionary[0]).toMatchObject({ size: PACK.length, sha256: sha(PACK), storedSize: PACK.length, storedSha256: sha(PACK) })
    const onnx = files.find(file => file.name === 'ettin-150m-wsd-int8.onnx.gz')!
    expect(pinned.bundles.model[0]).toMatchObject({ size: onnx.size, sha256: onnx.sha256, storedSize: 50_000 })
    expect(manifest.bundles.model[0]!.size).toBeNull() // the input is not changed
  })

  test('formatPins lists every file with its size and SHA-256', async () => {
    const { files } = await staged()
    const printed = formatPins(files)
    for (const file of files) {
      expect(printed).toContain(file.name)
      expect(printed).toContain(file.sha256)
      expect(printed).toContain(String(file.size))
    }
    expect(printed).toContain(sha(CONTENT['onnx/model.int8.onnx']!))
  })

  test('releaseNotes state what each file is, its licence, size and SHA-256, and the Wiktionary snapshot', async () => {
    const { manifest, files } = await staged()
    const notes = releaseNotes(manifest, files, { snapshot: '2026-10-30' })
    for (const file of files) {
      expect(notes).toContain(`\`${file.name}\``)
      expect(notes).toContain(file.sha256)
      expect(notes).toContain(file.size.toLocaleString('en-US'))
    }
    expect(notes).toContain('2026-10-30')
    expect(notes).toContain('CC BY-SA 4.0')
    expect(notes).toContain('Apache-2.0')
    expect(notes).toContain('MIT')
    expect(notes).toContain('8751b577199d1bb95b74fa2457da7065d57100ae')
    expect(notes).toContain(sha(CONTENT['onnx/model.int8.onnx']!))
  })

  test('releaseNotes say the model was fine-tuned here, from what, on what, and with which teacher', async () => {
    const { manifest, files } = await staged()
    const notes = releaseNotes(manifest, files, { snapshot: '2026-10-30' })
    // The trained checkpoint's revision, the base checkpoint and its revision, the teacher and its revision.
    expect(notes).toContain('sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3')
    expect(notes).toContain('sign/Ettin-150m-WSD')
    expect(notes).toContain('sign/Ettin-1B-WSD')
    expect(notes).toContain('e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc')
    // The training data and their licences.
    expect(notes).toContain('English Wiktionary')
    expect(notes).toContain('English Wikipedia')
    expect(notes).toContain('CC BY-SA 3.0')
    expect(notes).toContain('docs/validation.md')
  })

  test('releaseNotes refuse a file they cannot describe', async () => {
    const { manifest, files } = await staged()
    expect(() => releaseNotes(manifest, [...files, { ...files[0]!, name: 'mystery.bin' }], { snapshot: '2026-10-30' })).toThrow('mystery.bin')
  })

  test('repoOf and releaseUrl derive the repository and download URLs from the base URL', () => {
    expect(repoOf(BASE)).toBe('owner/repo')
    expect(() => repoOf('https://example.org/releases/download')).toThrow()
    expect(() => repoOf('http://127.0.0.1:8000/files')).toThrow()
    const manifest = { tag: 'assets-v1', baseUrl: BASE } as AssetManifest
    expect(releaseUrl(manifest, 'NOTICES-model.txt')).toBe(`${BASE}/assets-v1/NOTICES-model.txt`)
  })

  test('releaseTitle follows the tag, and refuses a tag that is not assets-v<n>', () => {
    expect(releaseTitle('assets-v1')).toBe('Dictionary pack and model files v1')
    expect(releaseTitle('assets-v2')).toBe('Dictionary pack and model files v2')
    expect(releaseTitle('assets-v12')).toBe('Dictionary pack and model files v12')
    for (const tag of ['v0.4.0', 'assets-v0', 'assets-v02', 'assets-v2-rc1', 'assets-2']) expect(() => releaseTitle(tag)).toThrow(ReleaseError)
  })
})

type Call = { command: string; args: string[] }
/** A fake command runner: `answer` decides each call's result; unhandled calls succeed with no output. */
function fakeRun(answer: (call: Call) => Partial<Awaited<ReturnType<Run>>> | undefined = () => undefined) {
  const calls: Call[] = []
  const run: Run = async (command, args) => {
    const call = { command, args }
    calls.push(call)
    return { code: 0, stdout: '', stderr: '', ...answer(call) }
  }
  return { run, calls }
}
const NOT_FOUND = { code: 1, stderr: 'gh: Not Found (HTTP 404)' }
const isRefCheck = (call: Call) => call.args[0] === 'api' && call.args.some(arg => arg.includes('/git/ref/tags/'))
const isReleaseList = (call: Call) => call.args[0] === 'api' && call.args.some(arg => arg.includes('/releases?'))

/** A fetch that serves the staged files at their release URLs, records calls, and lets a test alter answers. */
function fakeFetch(files: StagedFile[], change?: (url: string, attempt: number) => Response | undefined) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const custom = change?.(url, calls.filter(call => call.url === url).length)
    if (custom) return custom
    const file = files.find(entry => url === `${BASE}/assets-v1/${entry.name}`)
    return file ? new Response(new Uint8Array(await fsp.readFile(file.path))) : new Response('missing', { status: 404 })
  }
  return { fetch, calls }
}

describe('releaseExists', () => {
  test('is true when the tag exists', async () => {
    const { run, calls } = fakeRun()
    expect(await releaseExists(run, 'owner/repo', 'assets-v1')).toBe(true)
    expect(calls[0]).toEqual({ command: 'gh', args: ['api', 'repos/owner/repo/git/ref/tags/assets-v1'] })
  })

  test('is true when a release (a draft, for example) holds the tag without the tag existing yet', async () => {
    const { run } = fakeRun(call => isRefCheck(call) ? NOT_FOUND : isReleaseList(call) ? { stdout: 'v0.1.0\nassets-v1\n' } : undefined)
    expect(await releaseExists(run, 'owner/repo', 'assets-v1')).toBe(true)
  })

  test('is false when neither the tag nor a release exists', async () => {
    const { run, calls } = fakeRun(call => isRefCheck(call) ? NOT_FOUND : isReleaseList(call) ? { stdout: 'assets-v10\n' } : undefined)
    expect(await releaseExists(run, 'owner/repo', 'assets-v1')).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test('throws when it cannot tell', async () => {
    await expect(releaseExists(fakeRun(() => ({ code: 1, stderr: 'gh: Bad credentials (HTTP 401)' })).run, 'owner/repo', 'assets-v1')).rejects.toThrow('401')
    await expect(releaseExists(fakeRun(call => isRefCheck(call) ? NOT_FOUND : { code: 1, stderr: 'network down' }).run, 'owner/repo', 'assets-v1')).rejects.toThrow('network down')
  })
})

describe('publishRelease', () => {
  const draftAssets = (files: StagedFile[], change: (asset: { name: string; size: number; digest: string | null }) => object = asset => asset) =>
    JSON.stringify({ draft: true, assets: files.map(file => change({ name: file.name, size: file.size, digest: `sha256:${file.sha256}` })) })

  // The release list check answers with tag names; the draft check with JSON lines.
  const noRelease = (call: Call) => isRefCheck(call) ? NOT_FOUND : isReleaseList(call) && call.args.includes('.[].tag_name') ? { stdout: '' } : undefined
  async function setup(answer?: (call: Call, files: StagedFile[]) => Partial<Awaited<ReturnType<Run>>> | undefined, change?: Parameters<typeof fakeFetch>[1]) {
    const { manifest, files, dir } = await staged()
    const notesFile = path.join(dir, 'notes.md')
    await fsp.writeFile(notesFile, 'notes')
    const gh = fakeRun(call => answer?.(call, files) ?? noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files)}\n` } : undefined))
    const network = fakeFetch(files, change)
    const log: string[] = []
    const options = { run: gh.run, fetch: network.fetch, manifest, files, title: 'Dictionary pack and model files v1', notesFile, log: (line: string) => log.push(line), retryMs: 0 }
    return { ...options, calls: gh.calls, fetches: network.calls, logged: log }
  }

  test('creates a draft prerelease with every file, checks its assets, publishes it, then verifies anonymous downloads', async () => {
    const context = await setup((call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files)}\n` } : undefined))
    const results = await publishRelease(context)
    const commands = context.calls.map(call => call.args.slice(0, 2).join(' '))
    expect(commands).toEqual(['api repos/owner/repo/git/ref/tags/assets-v1', 'api --paginate', 'release create', 'api --paginate', 'release edit'])
    const create = context.calls[2]!.args
    expect(create).toEqual(expect.arrayContaining(['assets-v1', '--repo', 'owner/repo', '--draft', '--prerelease', '--latest=false', '--title', 'Dictionary pack and model files v1', '--notes-file', context.notesFile]))
    expect(create.slice(-8)).toEqual(context.files.map(file => file.path))
    expect(context.calls[4]!.args).toEqual(['release', 'edit', 'assets-v1', '--repo', 'owner/repo', '--draft=false'])
    expect(context.fetches.map(call => call.url)).toEqual(context.files.map(file => `${BASE}/assets-v1/${file.name}`))
    for (const call of context.fetches) {
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false)
      expect(call.init?.credentials).toBe('omit')
    }
    expect(results.map(result => result.name)).toEqual(RELEASE_NAMES)
    expect(results.every(result => result.ok)).toBe(true)
  })

  test('refuses an existing tag and creates nothing', async () => {
    const context = await setup(call => isRefCheck(call) ? { stdout: '{"ref":"refs/tags/assets-v1"}' } : undefined)
    await expect(publishRelease(context)).rejects.toThrow(/assets-v1 already exists/)
    expect(context.calls.some(call => call.args[0] === 'release')).toBe(false)
    expect(context.fetches).toHaveLength(0)
  })

  test('stops when gh cannot create the draft', async () => {
    const context = await setup(call => noRelease(call) ?? (call.args[1] === 'create' ? { code: 1, stderr: 'upload failed' } : undefined))
    await expect(publishRelease(context)).rejects.toThrow('upload failed')
    expect(context.calls.some(call => call.args[1] === 'edit')).toBe(false)
  })

  test('leaves the draft unpublished when an uploaded asset differs or is missing', async () => {
    for (const change of [
      (asset: { name: string; size: number; digest: string | null }) => asset.name === 'tokenizer.json' ? { ...asset, size: 1 } : asset,
      (asset: { name: string; size: number; digest: string | null }) => asset.name === 'calibration.json' ? { ...asset, digest: `sha256:${'0'.repeat(64)}` } : asset,
    ]) {
      const context = await setup((call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files, change)}\n` } : undefined))
      await expect(publishRelease(context)).rejects.toBeInstanceOf(ReleaseError)
      expect(context.calls.some(call => call.args[1] === 'edit')).toBe(false)
    }
    const missing = await setup((call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files.slice(1))}\n` } : undefined))
    await expect(publishRelease(missing)).rejects.toMatchObject({ problems: [expect.stringContaining('wiktionary-en-v1.pack')] })
    const none = await setup(call => noRelease(call) ?? (isReleaseList(call) ? { stdout: '' } : undefined))
    await expect(publishRelease(none)).rejects.toThrow(/draft/)
  })

  test('accepts a draft asset whose digest GitHub has not computed', async () => {
    const context = await setup((call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files, asset => ({ ...asset, digest: null }))}\n` } : undefined))
    await expect(publishRelease(context)).resolves.toHaveLength(8)
  })

  test('stops when gh cannot publish the draft', async () => {
    const context = await setup((call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files)}\n` } : call.args[1] === 'edit' ? { code: 1, stderr: 'edit refused' } : undefined))
    await expect(publishRelease(context)).rejects.toThrow('edit refused')
    expect(context.fetches).toHaveLength(0)
  })

  test('reports a published file that downloads with other bytes', async () => {
    const context = await setup(
      (call, files) => noRelease(call) ?? (isReleaseList(call) ? { stdout: `${draftAssets(files)}\n` } : undefined),
      url => url.endsWith('/calibration.json') ? new Response('tampered') : undefined,
    )
    await expect(publishRelease(context)).rejects.toMatchObject({ problems: [expect.stringContaining('calibration.json')] })
  })
})

describe('verifyDownload and traceRedirects', () => {
  const data = new TextEncoder().encode('published bytes')
  const expected = { size: data.length, sha256: sha(data) }

  test('verifyDownload retries a file that is not served yet, then checks size and SHA-256', async () => {
    let calls = 0
    const fetch = async () => (++calls < 3 ? new Response('no', { status: 404 }) : new Response(data))
    expect(await verifyDownload(fetch, 'https://x.test/a', expected, { attempts: 3, retryMs: 0 })).toMatchObject({ ok: true, size: data.length, sha256: expected.sha256, status: 200 })
    expect(calls).toBe(3)
  })

  test('verifyDownload reports a status, a wrong size and a network error', async () => {
    expect(await verifyDownload(async () => new Response('no', { status: 404 }), 'https://x.test/a', expected, { attempts: 2, retryMs: 0 })).toMatchObject({ ok: false, status: 404 })
    expect(await verifyDownload(async () => new Response('short'), 'https://x.test/a', expected, { attempts: 1, retryMs: 0 })).toMatchObject({ ok: false, size: 5 })
    expect(await verifyDownload(async () => { throw new TypeError('fetch failed') }, 'https://x.test/a', expected, { attempts: 1, retryMs: 0 })).toMatchObject({ ok: false, error: 'fetch failed' })
  })

  test('traceRedirects follows Location by hand and records each hop without query strings', async () => {
    const seen: Array<RequestInit | undefined> = []
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push(init)
      if (url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.example/blob/1?sig=secret&se=1' } })
      return new Response('data', { status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } })
    }
    const hops = await traceRedirects(fetch, 'https://github.com/owner/repo/releases/download/assets-v1/a.json', { origin: 'chrome-extension://abc' })
    expect(hops).toEqual([
      { url: 'https://github.com/owner/repo/releases/download/assets-v1/a.json', status: 302, location: 'https://release-assets.example/blob/1', headers: {} },
      { url: 'https://release-assets.example/blob/1', status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } },
    ])
    expect(seen.every(init => init?.redirect === 'manual' && new Headers(init.headers).get('origin') === 'chrome-extension://abc')).toBe(true)
    expect(JSON.stringify(hops)).not.toContain('secret')
  })

  test('traceRedirects stops after too many hops', async () => {
    const fetch = async () => new Response(null, { status: 302, headers: { location: 'https://loop.test/again' } })
    expect(await traceRedirects(fetch, 'https://loop.test/start', { maxHops: 3 })).toHaveLength(3)
  })
})

describe('the model from a pinned Hugging Face revision', () => {
  const SOURCE: HubSource = { repo: 'owner/model', revision: '0123456789abcdef0123456789abcdef01234567' }
  const urlOf = (source: HubSource, relative: string) => `https://huggingface.co/${source.repo}/resolve/${source.revision}/${relative}`

  /** A fetch that serves the export's files at their resolve URLs of `source`; `change` can answer instead. */
  function hubFetch(source: HubSource, change?: (relative: string) => Response | Promise<Response> | undefined) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      const relative = Object.keys(CONTENT).find(name => url === urlOf(source, name))
      if (!relative) return new Response('Entry not found', { status: 404 })
      return (await change?.(relative)) ?? new Response(new Uint8Array(CONTENT[relative]!))
    }
    return { fetch, calls }
  }

  test('the source of the current manifest is a full commit of the published model repository', () => {
    expect(MODEL_SOURCE).toEqual({ tag: 'assets-v2', repo: 'andrepaim/Ettin-150m-WSD-wiktionary', revision: '0edcbab04bb30eadeeef6babb26e8055b173b8d7' })
    expect(MODEL_SOURCE.tag).toBe(ASSET_MANIFEST.tag)
    expect(hubSource(MODEL_SOURCE.repo, MODEL_SOURCE.revision)).toEqual({ repo: MODEL_SOURCE.repo, revision: MODEL_SOURCE.revision })
  })

  test('the cache keeps a revision in <cache>/<owner>/<name>/<revision>/, under ~/.cache/contextual-dictionary/hf-models by default', () => {
    expect(defaultHubCache('/home/maintainer')).toBe('/home/maintainer/.cache/contextual-dictionary/hf-models')
    expect(hubModelDir('/c', SOURCE)).toBe(`/c/owner/model/${SOURCE.revision}`)
    expect(hubModelDir(defaultHubCache('/h'), MODEL_SOURCE)).toBe(`/h/.cache/contextual-dictionary/hf-models/andrepaim/Ettin-150m-WSD-wiktionary/${MODEL_SOURCE.revision}`)
  })

  test('hubFileUrl is the resolve URL of a file at the revision', () => {
    expect(hubFileUrl(SOURCE, 'onnx/model.int8.onnx')).toBe(urlOf(SOURCE, 'onnx/model.int8.onnx'))
    expect(Object.values(MODEL_EXPORT_PATHS).sort()).toEqual(Object.keys(CONTENT).sort())
  })

  test('hubSource refuses moving references, short hashes and malformed repositories', () => {
    for (const revision of ['main', 'affc67b9', 'refs/pr/1', `${'a'.repeat(39)}g`, 'A'.repeat(40), `${'a'.repeat(40)}\n`]) expect(() => hubSource('owner/model', revision)).toThrow(ReleaseError)
    for (const repo of ['model', 'owner/model/extra', '../model', 'owner/../model', 'owner/model?x=1', 'https://huggingface.co/owner/model', '']) expect(() => hubSource(repo, SOURCE.revision)).toThrow(ReleaseError)
  })

  test('downloads the five files at the revision without credentials, checks them and returns an export folder that stages', async () => {
    const setup = await inputs()
    const cache = path.join(setup.dir, 'cache')
    const network = hubFetch(SOURCE)
    const log: string[] = []
    const dir = await downloadHubModel(network.fetch, setup.manifest, SOURCE, cache, line => log.push(line))
    expect(dir).toBe(path.join(cache, 'owner', 'model', SOURCE.revision))
    expect(network.calls.map(call => call.url).sort()).toEqual(Object.keys(CONTENT).map(name => urlOf(SOURCE, name)).sort())
    for (const call of network.calls) {
      expect(call.init?.credentials).toBe('omit')
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false)
    }
    for (const [name, data] of Object.entries(CONTENT)) expect(new Uint8Array(await fsp.readFile(path.join(dir, name)))).toEqual(data)
    expect(log.join('\n')).toContain(SOURCE.revision)
    const files = await stageRelease(setup.manifest, { ...setup.release, modelDir: dir }, setup.out)
    expect(files.map(file => file.name)).toEqual(RELEASE_NAMES)
  })

  test('reuses cached files that match their pins and downloads again one that does not', async () => {
    const setup = await inputs()
    const cache = path.join(setup.dir, 'cache')
    const dir = await downloadHubModel(hubFetch(SOURCE).fetch, setup.manifest, SOURCE, cache, () => {})
    await fsp.writeFile(path.join(dir, 'calibration.json'), 'damaged')
    const again = hubFetch(SOURCE)
    expect(await downloadHubModel(again.fetch, setup.manifest, SOURCE, cache, () => {})).toBe(dir)
    expect(again.calls.map(call => call.url)).toEqual([urlOf(SOURCE, 'calibration.json')])
    expect(new Uint8Array(await fsp.readFile(path.join(dir, 'calibration.json')))).toEqual(CONTENT['calibration.json'])
  })

  const refusal = async (change: (relative: string) => Response | Promise<Response> | undefined) => {
    const setup = await inputs()
    const cache = path.join(setup.dir, 'cache')
    try {
      await downloadHubModel(hubFetch(SOURCE, change).fetch, setup.manifest, SOURCE, cache, () => {})
    } catch (error) {
      expect(error).toBeInstanceOf(ReleaseError)
      const dir = path.join(cache, 'owner', 'model', SOURCE.revision)
      const left = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []
      return { message: (error as ReleaseError).message, left }
    }
    throw new Error('downloadHubModel did not refuse')
  }

  test('refuses a file whose bytes differ from the stored pins, and keeps nothing of it', async () => {
    const { message, left } = await refusal(relative => relative === 'tokenizer.json' ? new Response(text(4_000, 'other ')) : undefined)
    expect(message).toContain('tokenizer.json')
    expect(message).toContain(sha(CONTENT['tokenizer.json']!))
    expect(left).not.toContain('tokenizer.json')
    expect(left.some(name => name.includes('partial'))).toBe(false)
  })

  test('refuses a file of another size, longer or shorter', async () => {
    expect((await refusal(relative => relative === 'onnx/model.int8.onnx' ? new Response(text(60_000, 'weights ')) : undefined)).message).toContain('model.int8.onnx')
    expect((await refusal(relative => relative === 'calibration.json' ? new Response('{}') : undefined)).message).toContain('calibration.json')
  })

  test('refuses an HTTP error and a network error, naming the URL', async () => {
    const missing = await refusal(relative => relative === 'model_metadata.json' ? new Response('Entry not found', { status: 404 }) : undefined)
    expect(missing.message).toContain('404')
    expect(missing.message).toContain(urlOf(SOURCE, 'model_metadata.json'))
    const offline = await refusal(relative => relative === 'tokenizer_config.json' ? Promise.reject(new TypeError('fetch failed')) : undefined)
    expect(offline.message).toContain('fetch failed')
    expect(offline.message).toContain(urlOf(SOURCE, 'tokenizer_config.json'))
  })

  test('refuses a manifest whose model files have no stored pins, before any download', async () => {
    const setup = await inputs()
    Object.assign(setup.manifest.bundles.model[1]!, { storedSize: null, storedSha256: null })
    const network = hubFetch(SOURCE)
    await expect(downloadHubModel(network.fetch, setup.manifest, SOURCE, path.join(setup.dir, 'cache'), () => {})).rejects.toThrow('model_metadata.json')
    expect(network.calls).toHaveLength(0)
  })
})

describe('parseOptions and main', () => {
  const ROOT = '/repo'
  const HOME = '/home/maintainer'

  test('parseOptions has defaults for the maintainer machine and reads overrides', () => {
    expect(parseOptions([], { root: ROOT, home: HOME })).toEqual({
      dryRun: false, fetchModel: false, keep: false, out: undefined,
      model: undefined,
      hubCache: '/home/maintainer/.cache/contextual-dictionary/hf-models',
      packPath: '/home/maintainer/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack',
      packSha256: undefined, packSize: undefined, noticesDir: '/repo/notices', statsFile: '/repo/docs/dictionary-stats.json',
    })
    expect(parseOptions(['--dry-run', '--keep', '--out=/tmp/x', '--model-dir', '/m', '--pack=/p.pack', `--pack-sha256=${'a'.repeat(64)}`, '--pack-size=12'], { root: ROOT, home: HOME }))
      .toMatchObject({ dryRun: true, keep: true, out: '/tmp/x', model: { dir: '/m' }, packPath: '/p.pack', packSha256: 'a'.repeat(64), packSize: 12 })
    expect(parseOptions(['--hf-repo=owner/model', `--hf-revision=${'0'.repeat(40)}`, '--hf-cache=/c'], { root: ROOT, home: HOME }))
      .toMatchObject({ model: { repo: 'owner/model', revision: '0'.repeat(40) }, hubCache: '/c' })
  })

  test('parseOptions refuses unknown options and malformed pins', () => {
    expect(() => parseOptions(['--publish-anyway'], { root: ROOT, home: HOME })).toThrow()
    expect(() => parseOptions(['--pack-sha256=xyz'], { root: ROOT, home: HOME })).toThrow('pack-sha256')
    expect(() => parseOptions(['--pack-size=-3'], { root: ROOT, home: HOME })).toThrow('pack-size')
  })

  test('parseOptions refuses a moving or short revision, half a Hugging Face source, and two sources at once', () => {
    const parse = (argv: string[]) => () => parseOptions(argv, { root: ROOT, home: HOME })
    for (const revision of ['main', 'affc67b9', 'v1.0', 'refs/pr/1', 'A'.repeat(40)]) expect(parse(['--hf-repo=owner/model', `--hf-revision=${revision}`])).toThrow(ReleaseError)
    expect(parse([`--hf-revision=${'0'.repeat(40)}`])).toThrow('--hf-repo')
    expect(parse(['--hf-repo=owner/model'])).toThrow('--hf-revision')
    expect(parse(['--model-dir=/m', '--hf-repo=owner/model', `--hf-revision=${'0'.repeat(40)}`])).toThrow('--model-dir')
  })

  async function mainSetup() {
    const setup = await inputs()
    const statsFile = path.join(setup.dir, 'stats.json')
    await fsp.writeFile(statsFile, JSON.stringify({ snapshot: '2026-10-30', pack: { bytes: PACK.length, sha256: sha(PACK) } }))
    const log: string[] = []
    const argv = [`--model-dir=${setup.modelDir}`, `--pack=${setup.packPath}`, `--out=${setup.out}`]
    const deps = (run: Run, fetch: Parameters<typeof publishRelease>[0]['fetch']) => ({
      run, fetch, log: (line: string) => log.push(line), error: (line: string) => log.push(`ERROR ${line}`),
      manifest: setup.manifest, root: setup.dir, home: setup.dir, retryMs: 0,
    })
    return { setup, statsFile, log, argv: [...argv, `--stats=${statsFile}`, `--notices=${setup.noticesDir}`], deps }
  }

  test('a dry run stages and prints the pins and the notes, and runs no command and no download', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    const gh = fakeRun()
    const network = fakeFetch([])
    expect(await main(['--dry-run', ...argv], deps(gh.run, network.fetch))).toBe(0)
    expect(gh.calls).toHaveLength(0)
    expect(network.calls).toHaveLength(0)
    const printed = log.join('\n')
    expect(printed).toContain('ettin-150m-wsd-int8.onnx.gz')
    expect(printed).toContain(sha(PACK))
    expect(printed).toContain('Dry run')
    expect(printed).toContain('2026-10-30')
    expect(fs.readdirSync(setup.out)).toEqual(expect.arrayContaining(RELEASE_NAMES))
  })

  /** A fetch serving the fixture export at the resolve URLs of `source`. */
  const hubServer = (source: { repo: string; revision: string }) => {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      const relative = Object.keys(CONTENT).find(name => url === `https://huggingface.co/${source.repo}/resolve/${source.revision}/${name}`)
      return relative ? new Response(new Uint8Array(CONTENT[relative]!)) : new Response('Entry not found', { status: 404 })
    }
    return { fetch, urls }
  }

  test('without --model-dir, a dry run stages the model from the pinned Hugging Face revision of the manifest', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    const withoutDir = argv.filter(arg => !arg.startsWith('--model-dir='))
    const hub = hubServer(MODEL_SOURCE)
    const gh = fakeRun()
    expect(await main(['--dry-run', ...withoutDir], { ...deps(gh.run, hub.fetch), manifest: { ...setup.manifest, tag: MODEL_SOURCE.tag } })).toBe(0)
    expect(hub.urls).toHaveLength(5)
    expect(hub.urls.every(url => url.startsWith(`https://huggingface.co/${MODEL_SOURCE.repo}/resolve/${MODEL_SOURCE.revision}/`))).toBe(true)
    expect(gh.calls).toHaveLength(0)
    expect(fs.existsSync(path.join(setup.dir, '.cache/contextual-dictionary/hf-models', MODEL_SOURCE.repo, MODEL_SOURCE.revision, 'onnx/model.int8.onnx'))).toBe(true)
    expect(log.join('\n')).toContain('Dry run')
    expect(fs.readdirSync(setup.out)).toEqual(expect.arrayContaining(RELEASE_NAMES))
  })

  test('stages from --hf-repo and --hf-revision when given, and stops on a download that differs', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    const source = { repo: 'owner/model', revision: 'f'.repeat(40) }
    const withoutDir = argv.filter(arg => !arg.startsWith('--model-dir='))
    const hub = hubServer(source)
    expect(await main(['--dry-run', ...withoutDir, `--hf-repo=${source.repo}`, `--hf-revision=${source.revision}`], deps(fakeRun().run, hub.fetch))).toBe(0)
    expect(hub.urls).toHaveLength(5)
    const other = hubServer({ ...source, revision: 'e'.repeat(40) })
    const again = path.join(setup.dir, 'again')
    await fsp.mkdir(again)
    const args = ['--dry-run', ...withoutDir.filter(arg => !arg.startsWith('--out=')), `--out=${again}`, `--hf-repo=${source.repo}`, `--hf-revision=${'e'.repeat(40)}`]
    Object.assign(setup.manifest.bundles.model[3]!, { storedSha256: 'd'.repeat(64) })
    expect(await main(args, deps(fakeRun().run, other.fetch))).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR [^\n]*do not match[\s\S]*tokenizer\.json/)
    expect(fs.readdirSync(again)).toEqual([])
  })

  test('--fetch-model downloads and checks the model of the manifest into the cache, and stages, publishes and reads nothing else', async () => {
    const { setup, log, deps } = await mainSetup()
    const hub = hubServer(MODEL_SOURCE)
    const gh = fakeRun()
    // No pack, notices or statistics file: none is needed to fetch the model.
    expect(await main(['--fetch-model', `--out=${setup.out}`], { ...deps(gh.run, hub.fetch), manifest: { ...setup.manifest, tag: MODEL_SOURCE.tag } })).toBe(0)
    const dir = hubModelDir(defaultHubCache(setup.dir), MODEL_SOURCE)
    expect(hub.urls).toHaveLength(5)
    for (const [name, data] of Object.entries(CONTENT)) expect(new Uint8Array(await fsp.readFile(path.join(dir, name)))).toEqual(data)
    expect(gh.calls).toHaveLength(0)
    expect(fs.readdirSync(setup.out)).toEqual([])
    expect(log.join('\n')).toContain(dir)
    expect(log.join('\n')).not.toContain('Staged')
  })

  test('--fetch-model refuses a local export and a download that differs from the stored pins', async () => {
    const { setup, log, deps } = await mainSetup()
    const manifest = { ...setup.manifest, tag: MODEL_SOURCE.tag }
    expect(await main(['--fetch-model', '--model-dir=/m'], { ...deps(fakeRun().run, hubServer(MODEL_SOURCE).fetch), manifest })).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR .*--fetch-model/)
    log.length = 0
    Object.assign(setup.manifest.bundles.model[2]!, { storedSha256: 'c'.repeat(64) })
    expect(await main(['--fetch-model'], { ...deps(fakeRun().run, hubServer(MODEL_SOURCE).fetch), manifest })).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR [\s\S]*calibration\.json/)
    expect(fs.existsSync(path.join(hubModelDir(defaultHubCache(setup.dir), MODEL_SOURCE), 'calibration.json'))).toBe(false)
  })

  test('without a model source, refuses a manifest that has no default one', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    const withoutDir = argv.filter(arg => !arg.startsWith('--model-dir='))
    const hub = hubServer(MODEL_SOURCE)
    expect(await main(['--dry-run', ...withoutDir], { ...deps(fakeRun().run, hub.fetch), manifest: { ...setup.manifest, tag: 'assets-v9' } })).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR .*assets-v9.*--model-dir/)
    expect(hub.urls).toHaveLength(0)
    expect(fs.readdirSync(setup.out)).toEqual([])
  })

  test('takes the pack pins from the statistics file unless given, and refuses a pack that differs', async () => {
    const { log, argv, deps } = await mainSetup()
    expect(await main(['--dry-run', ...argv, `--pack-sha256=${'c'.repeat(64)}`], deps(fakeRun().run, fakeFetch([]).fetch))).toBe(1)
    expect(log.join('\n')).toContain('wiktionary-en-v1.pack')
  })

  test('publishes, verifies the downloads and traces the redirects without --dry-run', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    let files: StagedFile[] = []
    const gh = fakeRun(call => {
      if (isRefCheck(call)) return NOT_FOUND
      if (isReleaseList(call) && call.args.includes('.[].tag_name')) return { stdout: '' }
      if (isReleaseList(call)) {
        files = RELEASE_NAMES.map(name => ({ name, path: path.join(setup.out, name) }) as StagedFile)
        const assets = files.map(file => { const bytes = fs.readFileSync(file.path); return { name: file.name, size: bytes.length, digest: `sha256:${sha(bytes)}` } })
        return { stdout: `${JSON.stringify({ draft: true, assets })}\n` }
      }
      return undefined
    })
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://release-assets.example/')) return new Response('x', { headers: { 'content-type': 'application/octet-stream' } })
      const name = url.slice(`${BASE}/assets-v1/`.length)
      if (init?.redirect === 'manual') return new Response(null, { status: 302, headers: { location: `https://release-assets.example/${name}?sig=1` } })
      return new Response(new Uint8Array(fs.readFileSync(path.join(setup.out, name))))
    }
    expect(await main(argv, deps(gh.run, fetch))).toBe(0)
    const create = gh.calls.find(call => call.args[0] === 'release' && call.args[1] === 'create')!.args
    expect(create[create.indexOf('--title') + 1]).toBe('Dictionary pack and model files v1')
    const printed = log.join('\n')
    expect(printed).toContain('Published')
    expect(printed).toContain('release-assets.example')
    expect(printed).not.toContain('sig=1')
  })

  test('titles the release after the manifest tag', async () => {
    const { setup, argv, deps } = await mainSetup()
    const manifest = { ...setup.manifest, tag: 'assets-v2' }
    const gh = fakeRun(call => {
      if (isRefCheck(call)) return NOT_FOUND
      if (isReleaseList(call) && call.args.includes('.[].tag_name')) return { stdout: '' }
      return undefined
    })
    // The draft is not found, so publishing stops after the create call.
    expect(await main(argv, { ...deps(gh.run, fakeFetch([]).fetch), manifest })).toBe(1)
    const create = gh.calls.find(call => call.args[0] === 'release' && call.args[1] === 'create')!.args
    expect(create[2]).toBe('assets-v2')
    expect(create[create.indexOf('--title') + 1]).toBe('Dictionary pack and model files v2')
  })

  test('refuses a manifest tag it cannot title before staging anything', async () => {
    const { setup, log, argv, deps } = await mainSetup()
    const gh = fakeRun()
    expect(await main(['--dry-run', ...argv], { ...deps(gh.run, fakeFetch([]).fetch), manifest: { ...setup.manifest, tag: 'v0.4.0' } })).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR .*v0\.4\.0/)
    expect(fs.readdirSync(setup.out)).toEqual([])
    expect(gh.calls).toHaveLength(0)
  })

  test('returns 1 and explains when publishing is refused', async () => {
    const { log, argv, deps } = await mainSetup()
    const gh = fakeRun(call => isRefCheck(call) ? { stdout: '{}' } : undefined)
    expect(await main(argv, deps(gh.run, fakeFetch([]).fetch))).toBe(1)
    expect(log.join('\n')).toMatch(/ERROR .*already exists/)
  })

  test('stages in a new directory under ~/.cache (a snap-installed gh cannot read /tmp) and removes it unless --keep', async () => {
    const { argv, deps, log, setup } = await mainSetup()
    const withoutOut = argv.filter(arg => !arg.startsWith('--out='))
    expect(await main(['--dry-run', ...withoutOut], deps(fakeRun().run, fakeFetch([]).fetch))).toBe(0)
    const removed = /Staged in (\S+)/.exec(log.join('\n'))![1]!
    expect(path.dirname(removed)).toBe(path.join(setup.dir, '.cache/contextual-dictionary'))
    expect(path.basename(removed)).toMatch(/^publish-assets-v1-/)
    expect(fs.existsSync(removed)).toBe(false)
    log.length = 0
    expect(await main(['--dry-run', '--keep', ...withoutOut], deps(fakeRun().run, fakeFetch([]).fetch))).toBe(0)
    const kept = /Staged in (\S+)/.exec(log.join('\n'))![1]!
    temps.push(kept)
    expect(fs.readdirSync(kept)).toEqual(expect.arrayContaining(RELEASE_NAMES))
  })
})
