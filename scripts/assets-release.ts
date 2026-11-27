// The logic of scripts/publish-assets.mjs: take the model files from a pinned
// Hugging Face revision (or a local model export), verify them and the
// dictionary pack against their pins, stage the release files, and publish
// them once as a GitHub prerelease, then download them back anonymously.
//
// Published assets never change. This refuses a tag that already exists, and
// it uploads into a draft first, so a failed upload never leaves a published
// release behind.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'
import { ASSET_MANIFEST, BUNDLE_NAMES, STORED_NAMES, type AssetManifest, type ManifestFile } from '../src/assets/manifest'

export interface Digest { size: number; sha256: string }

export interface StagedFile extends Digest {
  /** The release file name. */
  name: string
  /** Where it was staged. */
  path: string
  kind: 'dictionary' | 'model' | 'notice'
  encoding: 'identity' | 'gzip'
  /** The file as the extension keeps it (after gunzip for a gzip file); notices have none. */
  stored?: Digest & { name: string }
}

export interface ReleaseInputs {
  /** The model export directory (`onnx/model.int8.onnx`, the JSON files). */
  modelDir: string
  packPath: string
  /** The pack's expected size and SHA-256. */
  pack: Digest
  noticesDir: string
}

/** A refusal with every problem found. */
export class ReleaseError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length ? `${message}:\n  ${problems.join('\n  ')}` : message)
    this.name = 'ReleaseError'
  }
}

export const NOTICE_NAMES = ['NOTICES-model.txt', 'NOTICES-dictionary.txt'] as const

/** Where each stored model file comes from in the model export. */
export const MODEL_EXPORT_PATHS: Readonly<Record<string, string>> = {
  [STORED_NAMES.model]: 'onnx/model.int8.onnx',
  [STORED_NAMES.modelMetadata]: 'model_metadata.json',
  [STORED_NAMES.calibration]: 'calibration.json',
  [STORED_NAMES.tokenizer]: 'tokenizer.json',
  [STORED_NAMES.tokenizerConfig]: 'tokenizer_config.json',
}

/** The checkpoint the model was fine-tuned from (assets-v1 shipped it as is). */
export const CHECKPOINT = 'sign/Ettin-150m-WSD'
export const CHECKPOINT_REVISION = '8751b577199d1bb95b74fa2457da7065d57100ae'
/** The fine-tuned checkpoint of training round 1 (docs/validation.md): sha256 of its model.safetensors, as in model_metadata.json. */
export const TRAINED_REVISION = 'sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3'
export const TEACHER = 'sign/Ettin-1B-WSD'
export const TEACHER_REVISION = 'e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc'
/**
 * Where the model of the release `tag` is published: the Hugging Face
 * repository that sense-model's `wsd publish` wrote, at a full commit. Its
 * five files are byte for byte the model files the manifest stores.
 */
export const MODEL_SOURCE = { tag: 'assets-v2', repo: 'andrepaim/Ettin-150m-WSD-wiktionary', revision: '0edcbab04bb30eadeeef6babb26e8055b173b8d7' } as const

// ------------------------------------------------------------------ digests

/** Counts and hashes what passes through. */
function tap() {
  const hash = createHash('sha256')
  let size = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk) },
  })
  return { stream, digest: (): Digest => ({ size, sha256: hash.digest('hex') }) }
}

const discard = () => new Writable({ write(_chunk, _encoding, done) { done() } })

export async function digestFile(file: string): Promise<Digest> {
  const counter = tap()
  await pipeline(createReadStream(file), counter.stream, discard())
  return counter.digest()
}

/**
 * Sets the gzip header's modification time to zero and its OS byte to 255
 * ("unknown"), as the pack builder does, so the bytes do not depend on the
 * platform. Node writes no file name. Refuses anything but a plain header.
 */
function normalizeHeader() {
  let offset = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      for (let i = 0; i < chunk.length && offset + i < 10; i++) {
        const at = offset + i
        if ((at === 0 && chunk[i] !== 0x1f) || (at === 1 && chunk[i] !== 0x8b) || (at === 3 && chunk[i] !== 0)) return done(new Error('unexpected gzip header'))
        if (at >= 4 && at <= 7) chunk[i] = 0
        if (at === 9) chunk[i] = 255
      }
      offset += chunk.length
      done(null, chunk)
    },
  })
}

/** Gzips `source` into a new file `target` (never overwritten) with a deterministic header. */
export async function gzipFile(source: string, target: string, level = 9): Promise<Digest> {
  const counter = tap()
  await pipeline(createReadStream(source), zlib.createGzip({ level }), normalizeHeader(), counter.stream, createWriteStream(target, { flags: 'wx' }))
  return counter.digest()
}

/** Size and SHA-256 of the gunzipped content of `file`. */
export async function gunzipDigest(file: string): Promise<Digest> {
  const counter = tap()
  await pipeline(createReadStream(file), zlib.createGunzip(), counter.stream, discard())
  return counter.digest()
}

const describeDigest = (digest: Digest) => `${digest.size} bytes, SHA-256 ${digest.sha256}`
const sameDigest = (a: Digest, b: Digest) => a.size === b.size && a.sha256 === b.sha256

async function digestOrProblem(file: string, problems: string[]): Promise<Digest | undefined> {
  try { return await digestFile(file) } catch (error) {
    problems.push(`${file}: cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`)
    return undefined
  }
}

// ------------------------------------------------------------------ staging

interface Source { file: ManifestFile; kind: 'dictionary' | 'model'; path: string; expected: Digest }

function sources(manifest: AssetManifest, inputs: ReleaseInputs, problems: string[]): Source[] {
  const out: Source[] = []
  for (const bundle of BUNDLE_NAMES) {
    for (const file of manifest.bundles[bundle]) {
      if (file.storedName === STORED_NAMES.dictionary) {
        if (file.storedSize !== null && !sameDigest({ size: file.storedSize, sha256: file.storedSha256! }, inputs.pack)) {
          problems.push(`${file.storedName}: the manifest pins ${describeDigest({ size: file.storedSize, sha256: file.storedSha256! })}, but the expected pack is ${describeDigest(inputs.pack)}`)
          continue
        }
        out.push({ file, kind: 'dictionary', path: inputs.packPath, expected: inputs.pack })
        continue
      }
      const relative = MODEL_EXPORT_PATHS[file.storedName]
      if (!relative) { problems.push(`${file.name}: no known source for the stored file ${file.storedName}`); continue }
      if (file.storedSize === null || file.storedSha256 === null) { problems.push(`${file.name}: the manifest has no stored pins for ${file.storedName}`); continue }
      out.push({ file, kind: 'model', path: path.join(inputs.modelDir, relative), expected: { size: file.storedSize, sha256: file.storedSha256 } })
    }
  }
  return out
}

/**
 * Verifies every input against its pins, then stages the release in
 * `outDir`: the gzipped model graph, the small model files and the pack as
 * they are, and the notices. Checks the staged bytes (the gzip unpacks to
 * the pinned graph; transfer pins already in the manifest match).
 */
export async function stageRelease(manifest: AssetManifest, inputs: ReleaseInputs, outDir: string): Promise<StagedFile[]> {
  const problems: string[] = []
  const inputsFound = sources(manifest, inputs, problems)
  for (const source of inputsFound) {
    const actual = await digestOrProblem(source.path, problems)
    if (actual && !sameDigest(actual, source.expected)) problems.push(`${source.path} (${source.file.storedName}): ${describeDigest(actual)}; pinned ${describeDigest(source.expected)}`)
  }
  for (const name of NOTICE_NAMES) {
    const file = path.join(inputs.noticesDir, name)
    const found = await digestOrProblem(file, problems)
    if (found && found.size === 0) problems.push(`${file}: empty notice`)
  }
  if (problems.length) throw new ReleaseError('The inputs do not match their pins; nothing was staged', problems)

  const staged: StagedFile[] = []
  for (const { file, kind, path: source, expected } of inputsFound) {
    const target = path.join(outDir, file.name)
    const stored = { name: file.storedName, ...expected }
    if (file.encoding === 'gzip') {
      const transfer = await gzipFile(source, target)
      const unpacked = await gunzipDigest(target)
      if (!sameDigest(unpacked, expected)) problems.push(`${file.name}: unpacks to ${describeDigest(unpacked)}, not the pinned ${describeDigest(expected)}`)
      staged.push({ name: file.name, path: target, kind, encoding: 'gzip', ...transfer, stored })
    } else {
      await fsp.copyFile(source, target, constants.COPYFILE_EXCL)
      const copied = await digestFile(target)
      if (!sameDigest(copied, expected)) problems.push(`${file.name}: the staged copy is ${describeDigest(copied)}`)
      staged.push({ name: file.name, path: target, kind, encoding: 'identity', ...copied, stored })
    }
  }
  for (const name of NOTICE_NAMES) {
    const target = path.join(outDir, name)
    await fsp.copyFile(path.join(inputs.noticesDir, name), target, constants.COPYFILE_EXCL)
    staged.push({ name, path: target, kind: 'notice', encoding: 'identity', ...(await digestFile(target)) })
  }
  problems.push(...transferPinProblems(manifest, staged))
  if (problems.length) throw new ReleaseError('The staged files are not what the manifest pins', problems)
  return staged
}

// ------------------------------------------------------------------ the model from Hugging Face

/** A Hugging Face model repository at one commit. */
export interface HubSource { repo: string; revision: string }

const HUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/** `repo` and `revision` when `repo` is `owner/name` and `revision` a full commit hash; refuses branches, tags and short hashes. */
export function hubSource(repo: string, revision: string): HubSource {
  const parts = repo.split('/')
  if (parts.length !== 2 || !parts.every(part => HUB_NAME.test(part) && !part.includes('..'))) throw new ReleaseError(`Not a Hugging Face repository id (owner/name): ${JSON.stringify(repo)}`)
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new ReleaseError(`The Hugging Face revision must be a full commit hash (40 lower-case hex digits), not a branch, a tag or a short hash: ${JSON.stringify(revision)}`)
  return { repo, revision }
}

export const hubFileUrl = (source: HubSource, relative: string) => `https://huggingface.co/${source.repo}/resolve/${source.revision}/${relative}`

/** The model source of `manifest` when none is given: MODEL_SOURCE for its tag, or a refusal. */
export function defaultModelSource(manifest: AssetManifest): HubSource {
  if (manifest.tag === MODEL_SOURCE.tag) return { repo: MODEL_SOURCE.repo, revision: MODEL_SOURCE.revision }
  throw new ReleaseError(`No default model source for ${manifest.tag} (MODEL_SOURCE is for ${MODEL_SOURCE.tag}): pass --hf-repo with --hf-revision (a full commit hash), or --model-dir`)
}

/** Downloads `url` into `target` through a `.partial` file, keeping it only when it has the `expected` size and SHA-256. Returns the problem, if any. */
async function downloadChecked(fetch: Fetch, url: string, target: string, expected: Digest): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', credentials: 'omit', cache: 'no-store' })
  } catch (error) {
    return `${url}: network error (${(error as Error).message})`
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return `${url}: HTTP ${response.status}`
  }
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.partial`
  const hash = createHash('sha256')
  let size = 0
  const handle = await fsp.open(partial, 'w')
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > expected.size) break // stops the transfer
      hash.update(chunk)
      await handle.write(chunk)
    }
  } catch (error) {
    await handle.close()
    await fsp.rm(partial, { force: true })
    return `${url}: the download failed (${(error as Error).message})`
  }
  await handle.close()
  if (size > expected.size) {
    await fsp.rm(partial, { force: true })
    return `${url}: longer than the pinned ${expected.size} bytes`
  }
  const actual = { size, sha256: hash.digest('hex') }
  if (!sameDigest(actual, expected)) {
    await fsp.rm(partial, { force: true })
    return `${url}: ${describeDigest(actual)}; pinned ${describeDigest(expected)}`
  }
  await fsp.rename(partial, target)
  return undefined
}

/**
 * Puts the model files of `manifest` from `source` into
 * `<cacheDir>/<owner>/<name>/<revision>/` in the layout of a model export,
 * checking each against its stored size and SHA-256, and returns that folder.
 * A cached file that matches is not downloaded again. Throws a ReleaseError
 * listing every file that could not be downloaded or does not match.
 */
export async function downloadHubModel(fetch: Fetch, manifest: AssetManifest, source: HubSource, cacheDir: string, log: (line: string) => void): Promise<string> {
  hubSource(source.repo, source.revision)
  const problems: string[] = []
  const wanted: Array<{ relative: string; expected: Digest }> = []
  for (const file of manifest.bundles.model) {
    const relative = MODEL_EXPORT_PATHS[file.storedName]
    if (!relative) problems.push(`${file.name}: no known source for the stored file ${file.storedName}`)
    else if (file.storedSize === null || file.storedSha256 === null) problems.push(`${file.name}: the manifest has no stored pins for ${file.storedName}`)
    else wanted.push({ relative, expected: { size: file.storedSize, sha256: file.storedSha256 } })
  }
  if (problems.length) throw new ReleaseError('Cannot take the model from Hugging Face', problems)
  const dir = path.join(cacheDir, ...source.repo.split('/'), source.revision)
  log(`Model files of ${source.repo} at revision ${source.revision}, into ${dir}:`)
  for (const { relative, expected } of wanted) {
    const target = path.join(dir, relative)
    const cached = await digestFile(target).catch(() => undefined)
    if (cached && sameDigest(cached, expected)) { log(`  cached      ${relative}`); continue }
    const problem = await downloadChecked(fetch, hubFileUrl(source, relative), target, expected)
    if (problem) problems.push(problem)
    else log(`  downloaded  ${relative} (${expected.size} bytes, SHA-256 ${expected.sha256})`)
  }
  if (problems.length) throw new ReleaseError(`The model files of ${source.repo} at ${source.revision} do not match the stored pins of the manifest; nothing was staged`, problems)
  return dir
}

/** Transfer pins already in the manifest that differ from the staged files. */
function transferPinProblems(manifest: AssetManifest, staged: StagedFile[]): string[] {
  const problems: string[] = []
  for (const bundle of BUNDLE_NAMES) {
    for (const file of manifest.bundles[bundle]) {
      const found = staged.find(entry => entry.name === file.name)
      if (found && file.size !== null && !sameDigest(found, { size: file.size, sha256: file.sha256! })) {
        problems.push(`${file.name}: staged ${describeDigest(found)}; the manifest pins ${describeDigest({ size: file.size, sha256: file.sha256! })}`)
      }
    }
  }
  return problems
}

/** `manifest` with every pin taken from the staged files. */
export function pinnedManifest(manifest: AssetManifest, staged: StagedFile[]): AssetManifest {
  const pinned = structuredClone(manifest)
  for (const bundle of BUNDLE_NAMES) {
    pinned.bundles[bundle] = pinned.bundles[bundle].map(file => {
      const found = staged.find(entry => entry.name === file.name)
      if (!found?.stored) throw new ReleaseError(`${file.name} was not staged`)
      return { ...file, size: found.size, sha256: found.sha256, storedSize: found.stored.size, storedSha256: found.stored.sha256 }
    })
  }
  return pinned
}

/** The staged files and their pins, for the terminal. */
export function formatPins(staged: StagedFile[]): string {
  const width = Math.max(...staged.map(file => file.name.length))
  const lines = staged.map(file => {
    const stored = file.stored && file.encoding === 'gzip' ? `\n${' '.repeat(width + 2)}unpacks to ${file.stored.name}: ${String(file.stored.size).padStart(11)}  ${file.stored.sha256}` : ''
    return `${file.name.padEnd(width)}  ${String(file.size).padStart(11)}  ${file.sha256}${stored}`
  })
  return lines.join('\n')
}

// ------------------------------------------------------------------ notes

interface Description { what: (file: StagedFile) => string; licence: string }

const MODEL_LICENCE = 'Apache-2.0 (base checkpoint Apache-2.0, its base model MIT; trained on CC BY-SA text); see `NOTICES-model.txt`'
const DESCRIPTIONS: Record<string, Description> = {
  'wiktionary-en-v1.pack': {
    what: () => 'English Wiktionary dictionary pack, format v1 (`docs/pack-format.md`), built by `scripts/build-dictionary.ts` (`docs/dictionary-build.md`)',
    licence: 'CC BY-SA 4.0 (Wiktionary contributors, via Kaikki.org); see `NOTICES-dictionary.txt`',
  },
  'ettin-150m-wsd-int8.onnx.gz': {
    what: file => `Word-sense model fine-tuned from Ettin-150m-WSD on English Wiktionary examples, INT8 ONNX (five MatMuls in float, token embedding in float16), gzip level 9; unpacks to \`${file.stored!.name}\`, ${file.stored!.size.toLocaleString('en-US')} bytes, SHA-256 \`${file.stored!.sha256}\``,
    licence: MODEL_LICENCE,
  },
  'model_metadata.json': { what: () => 'Inference metadata: answer letters, template `compact-v1`, maximum length, the checkpoint revision, its base checkpoint, training data and export recipe', licence: MODEL_LICENCE },
  'calibration.json': { what: () => 'Calibration settings (identity, marked "uncalibrated")', licence: MODEL_LICENCE },
  'tokenizer.json': { what: () => 'Tokenizer of the checkpoint', licence: MODEL_LICENCE },
  'tokenizer_config.json': { what: () => 'Tokenizer configuration', licence: MODEL_LICENCE },
  'NOTICES-model.txt': { what: () => 'Model notices: the base checkpoint, the teacher, the training data and their licences, with the Apache-2.0 and MIT licence texts', licence: '—' },
  'NOTICES-dictionary.txt': { what: () => 'Dictionary notices, with the CC BY-SA 4.0 legal code', licence: '—' },
}

/** The release notes: what each file is, its licence, size and SHA-256. */
export function releaseNotes(manifest: AssetManifest, staged: StagedFile[], options: { snapshot: string }): string {
  const rows = staged.map(file => {
    const description = DESCRIPTIONS[file.name]
    if (!description) throw new ReleaseError(`No description for ${file.name}`)
    return `| \`${file.name}\` | ${description.what(file)} | ${description.licence} | ${file.size.toLocaleString('en-US')} | \`${file.sha256}\` |`
  })
  return [
    `Model and dictionary files downloaded by the Contextual Dictionary extension, release \`${manifest.tag}\`. The extension pins every file by size and SHA-256 in \`src/assets/manifest.ts\` and checks them as they download. Published assets never change; a new payload gets a new tag.`,
    '',
    '| File | What it is | Licence | Bytes | SHA-256 |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    `**Dictionary:** derived from the English Wiktionary (https://en.wiktionary.org/) through the Kaikki.org machine-readable extract made with wiktextract, snapshot of ${options.snapshot}. Distributed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).`,
    '',
    `**Model:** fine-tuned by this project (training round 1, \`docs/validation.md\`) from [${CHECKPOINT}](https://huggingface.co/${CHECKPOINT}/tree/${CHECKPOINT_REVISION}), revision \`${CHECKPOINT_REVISION}\` (Apache-2.0; its base model [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m), MIT). Trained checkpoint revision \`${TRAINED_REVISION}\`. Labels: English Wiktionary usage examples and quotations with the meaning their editors attached them to (Kaikki.org extract of ${options.snapshot}; Wiktionary text CC BY-SA 4.0 and GFDL). Soft labels: [${TEACHER}](https://huggingface.co/${TEACHER}/tree/${TEACHER_REVISION}), revision \`${TEACHER_REVISION}\` (Apache-2.0), on those examples and on English Wikipedia paragraphs (CC BY-SA 3.0 and GFDL). No training text is in these files. Exported to INT8 ONNX with the compact-v1 inference contract.`,
    '',
    'Check a download by hand with `sha256sum <file>` against the table above. See `docs/assets.md` in the repository.',
    '',
  ].join('\n')
}

/** `owner/repo` of a GitHub release download base URL. */
export function repoOf(baseUrl: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download$/.exec(baseUrl)
  if (!match) throw new ReleaseError(`Not a GitHub release download URL: ${baseUrl}`)
  return `${match[1]}/${match[2]}`
}

/** The release title for a tag `assets-v<n>`: "Dictionary pack and model files v<n>". */
export function releaseTitle(tag: string): string {
  const match = /^assets-v([1-9][0-9]*)$/.exec(tag)
  if (!match) throw new ReleaseError(`Cannot title the release ${tag}: assets tags are assets-v<n>`)
  return `Dictionary pack and model files v${match[1]}`
}

export const releaseUrl = (manifest: AssetManifest, name: string) => `${manifest.baseUrl}/${manifest.tag}/${encodeURIComponent(name)}`

// ------------------------------------------------------------------ publishing

export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const notFound = (result: { stdout: string; stderr: string }) => /HTTP 404|Not Found/.test(`${result.stderr}\n${result.stdout}`)

/** Whether the tag exists, or any release (a draft included) uses it. */
export async function releaseExists(run: Run, repo: string, tag: string): Promise<boolean> {
  const ref = await run('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`])
  if (ref.code === 0) return true
  if (!notFound(ref)) throw new ReleaseError(`Could not check the tag ${tag}: ${ref.stderr.trim() || ref.stdout.trim()}`)
  const releases = await run('gh', ['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', '.[].tag_name'])
  if (releases.code !== 0) throw new ReleaseError(`Could not list the releases: ${releases.stderr.trim() || releases.stdout.trim()}`)
  return releases.stdout.split('\n').map(line => line.trim()).includes(tag)
}

type DraftAsset = { name: string; size: number; digest: string | null }

async function draftAssets(run: Run, repo: string, tag: string): Promise<DraftAsset[] | undefined> {
  const jq = `.[] | select(.tag_name == "${tag}" and .draft) | {draft, assets: [.assets[] | {name, size, digest}]}`
  const result = await run('gh', ['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', jq])
  if (result.code !== 0) throw new ReleaseError(`Could not read the draft release: ${result.stderr.trim()}`)
  const line = result.stdout.split('\n').find(entry => entry.trim())
  return line ? (JSON.parse(line) as { assets: DraftAsset[] }).assets : undefined
}

export interface DownloadCheck extends Partial<Digest> { name: string; url: string; ok: boolean; status?: number; error?: string; ms: number }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Downloads `url` with no credentials and no authorisation header, and compares size and SHA-256. Retries a failed request. */
export async function verifyDownload(fetch: Fetch, url: string, expected: Digest, options: { attempts?: number; retryMs?: number } = {}): Promise<Omit<DownloadCheck, 'name'>> {
  const attempts = options.attempts ?? 4
  let last: Omit<DownloadCheck, 'name'> = { url, ok: false, ms: 0 }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = performance.now()
    try {
      const response = await fetch(url, { redirect: 'follow', credentials: 'omit', cache: 'no-store' })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        last = { url, ok: false, status: response.status, ms: performance.now() - started }
      } else {
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { hash.update(chunk); size += chunk.length }
        const sha256 = hash.digest('hex')
        return { url, ok: size === expected.size && sha256 === expected.sha256, status: response.status, size, sha256, ms: performance.now() - started }
      }
    } catch (error) {
      last = { url, ok: false, error: (error as Error).message, ms: performance.now() - started }
    }
    if (attempt < attempts) await sleep(options.retryMs ?? 5000)
  }
  return last
}

export interface Hop { url: string; status: number; location?: string; headers: Record<string, string> }

const TRACED_HEADERS = ['access-control-allow-origin', 'cross-origin-resource-policy', 'content-type', 'content-length', 'cache-control']
const withoutQuery = (value: string) => { const url = new URL(value); return `${url.origin}${url.pathname}` }

/** Follows the redirects of `url` by hand, recording each hop's status, target and CORS-related headers (query strings left out). */
export async function traceRedirects(fetch: Fetch, url: string, options: { origin?: string; maxHops?: number } = {}): Promise<Hop[]> {
  const hops: Hop[] = []
  let current = url
  for (let hop = 0; hop < (options.maxHops ?? 5); hop++) {
    const response = await fetch(current, { redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: options.origin ? { origin: options.origin } : {} })
    await response.body?.cancel()
    const headers: Record<string, string> = {}
    for (const name of TRACED_HEADERS) { const value = response.headers.get(name); if (value !== null) headers[name] = value }
    const location = response.headers.get('location')
    const next = location && response.status >= 300 && response.status < 400 ? new URL(location, current).toString() : undefined
    hops.push({ url: withoutQuery(current), status: response.status, ...(next ? { location: withoutQuery(next) } : {}), headers })
    if (!next) break
    current = next
  }
  return hops
}

export interface PublishOptions {
  run: Run
  fetch: Fetch
  manifest: AssetManifest
  files: StagedFile[]
  title: string
  notesFile: string
  log: (line: string) => void
  retryMs?: number
}

/**
 * Creates the release as a draft prerelease with every staged file, checks
 * the uploaded assets, publishes it, then downloads every file anonymously
 * and compares it with what was staged.
 */
export async function publishRelease(options: PublishOptions): Promise<DownloadCheck[]> {
  const { run, manifest, files, log } = options
  const repo = repoOf(manifest.baseUrl)
  const tag = manifest.tag
  if (await releaseExists(run, repo, tag)) throw new ReleaseError(`${tag} already exists in ${repo}. Published assets never change: use a new tag and new pins.`)

  log(`Uploading ${files.length} files to a draft release ${tag} of ${repo}…`)
  const create = await run('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--prerelease', '--latest=false', '--target', 'main', '--title', options.title, '--notes-file', options.notesFile, ...files.map(file => file.path)])
  if (create.code !== 0) throw new ReleaseError(`gh release create failed; nothing was published (a draft may be left to delete): ${create.stderr.trim()}`)

  const assets = await draftAssets(run, repo, tag)
  if (!assets) throw new ReleaseError(`The draft release ${tag} was not found after uploading; nothing was published`)
  const problems: string[] = []
  for (const file of files) {
    const asset = assets.find(entry => entry.name === file.name)
    if (!asset) problems.push(`${file.name}: missing from the draft`)
    else if (asset.size !== file.size) problems.push(`${file.name}: the draft holds ${asset.size} bytes, staged ${file.size}`)
    else if (asset.digest && asset.digest !== `sha256:${file.sha256}`) problems.push(`${file.name}: the draft's digest is ${asset.digest}, staged sha256:${file.sha256}`)
  }
  for (const asset of assets) if (!files.some(file => file.name === asset.name)) problems.push(`${asset.name}: in the draft but not staged`)
  if (problems.length) throw new ReleaseError(`The draft release ${tag} does not hold the staged files; it was left unpublished`, problems)

  const edit = await run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false'])
  if (edit.code !== 0) throw new ReleaseError(`gh release edit failed; the draft ${tag} was left unpublished: ${edit.stderr.trim()}`)
  log(`Published ${tag}. Downloading every file back without credentials…`)

  const results: DownloadCheck[] = []
  for (const file of files) {
    const result = { name: file.name, ...(await verifyDownload(options.fetch, releaseUrl(manifest, file.name), file, { retryMs: options.retryMs ?? 5000 })) }
    results.push(result)
    log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${file.name} ${result.size ?? '-'} bytes in ${(result.ms / 1000).toFixed(1)} s${result.status && result.status !== 200 ? ` (HTTP ${result.status})` : ''}${result.error ? ` (${result.error})` : ''}`)
  }
  const failed = results.filter(result => !result.ok)
  if (failed.length) throw new ReleaseError('Published files do not download as staged. Do not delete or overwrite the release; report it', failed.map(result => `${result.name}: ${JSON.stringify(result)}`))
  return results
}

// ------------------------------------------------------------------ command line

export interface Options {
  dryRun: boolean
  keep: boolean
  out: string | undefined
  /** A local model export, a Hugging Face revision, or undefined for the default source of the manifest. */
  model: { dir: string } | HubSource | undefined
  /** Where Hugging Face downloads are kept, under `<owner>/<name>/<revision>/`. */
  hubCache: string
  packPath: string
  packSha256: string | undefined
  packSize: number | undefined
  noticesDir: string
  statsFile: string
}

export function parseOptions(argv: string[], where: { root: string; home: string }): Options {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      out: { type: 'string' },
      'model-dir': { type: 'string' },
      'hf-repo': { type: 'string' },
      'hf-revision': { type: 'string' },
      'hf-cache': { type: 'string' },
      pack: { type: 'string' },
      'pack-sha256': { type: 'string' },
      'pack-size': { type: 'string' },
      notices: { type: 'string' },
      stats: { type: 'string' },
    },
  })
  const sha256 = values['pack-sha256']
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) throw new ReleaseError('--pack-sha256 must be 64 lower-case hex digits')
  const sizeText = values['pack-size']
  const size = sizeText === undefined ? undefined : Number(sizeText)
  if (size !== undefined && !(Number.isSafeInteger(size) && size > 0)) throw new ReleaseError('--pack-size must be a positive integer')
  const repo = values['hf-repo']
  const revision = values['hf-revision']
  if (repo === undefined && revision !== undefined) throw new ReleaseError('--hf-revision needs --hf-repo')
  if (repo !== undefined && revision === undefined) throw new ReleaseError('--hf-repo needs --hf-revision (a full commit hash)')
  if (repo !== undefined && values['model-dir'] !== undefined) throw new ReleaseError('Give either --model-dir or --hf-repo with --hf-revision, not both')
  const model = values['model-dir'] !== undefined ? { dir: values['model-dir'] } : repo !== undefined ? hubSource(repo, revision!) : undefined
  return {
    dryRun: values['dry-run'] ?? false,
    keep: values.keep ?? false,
    out: values.out,
    model,
    hubCache: values['hf-cache'] ?? path.join(where.home, '.cache/contextual-dictionary/hf-models'),
    packPath: values.pack ?? path.join(where.home, '.cache/contextual-dictionary/packs/wiktionary-en-v1.pack'),
    packSha256: sha256,
    packSize: size,
    noticesDir: values.notices ?? path.join(where.root, 'notices'),
    statsFile: values.stats ?? path.join(where.root, 'docs/dictionary-stats.json'),
  }
}

export interface MainDeps {
  run: Run
  fetch: Fetch
  log: (line: string) => void
  error: (line: string) => void
  manifest: AssetManifest
  root: string
  home: string
  retryMs?: number
}

/** The Origin an extension page sends, for observing CORS answers. */
const EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** Stages the release, prints its pins and notes, and publishes it unless `--dry-run`. Returns the exit code. */
export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let outDir: string | undefined
  let remove = false
  try {
    const options = parseOptions(argv, deps)
    const title = releaseTitle(deps.manifest.tag)
    const model = options.model ?? defaultModelSource(deps.manifest)
    const stats = JSON.parse(await fsp.readFile(options.statsFile, 'utf8')) as { snapshot: string; pack: { bytes: number; sha256: string } }
    const pack = { size: options.packSize ?? stats.pack.bytes, sha256: options.packSha256 ?? stats.pack.sha256 }
    if (options.out) outDir = options.out
    else {
      // Not the system temporary directory: gh installed as a snap cannot read /tmp.
      const parent = path.join(deps.home, '.cache/contextual-dictionary')
      await fsp.mkdir(parent, { recursive: true })
      outDir = await fsp.mkdtemp(path.join(parent, `publish-${deps.manifest.tag}-`))
      remove = !options.keep
    }
    await fsp.mkdir(outDir, { recursive: true })
    const modelDir = 'dir' in model ? model.dir : await downloadHubModel(deps.fetch, deps.manifest, model, options.hubCache, deps.log)
    deps.log(`Verifying the inputs and staging ${deps.manifest.tag}…`)
    const files = await stageRelease(deps.manifest, { modelDir, packPath: options.packPath, pack, noticesDir: options.noticesDir }, outDir)
    deps.log(`Staged in ${outDir}\n\n${formatPins(files)}\n`)
    const notes = releaseNotes(deps.manifest, files, { snapshot: stats.snapshot })
    const notesFile = path.join(outDir, `${deps.manifest.tag}-notes.md`)
    await fsp.writeFile(notesFile, notes, { flag: 'wx' })
    deps.log(`Release notes:\n\n${notes}`)
    deps.log(`Pinned manifest bundles:\n${JSON.stringify(pinnedManifest(deps.manifest, files).bundles, null, 2)}\n`)
    if (options.dryRun) {
      deps.log('Dry run: nothing was published.')
      return 0
    }
    await publishRelease({ run: deps.run, fetch: deps.fetch, manifest: deps.manifest, files, title, notesFile, log: deps.log, ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}) })
    deps.log('Every file downloads anonymously and matches. Redirects, as an extension page would see them:')
    for (const file of files) {
      const hops = await traceRedirects(deps.fetch, releaseUrl(deps.manifest, file.name), { origin: EXTENSION_ORIGIN })
      deps.log(`  ${file.name}: ${hops.map(hop => `${hop.status} ${new URL(hop.url).host}`).join(' -> ')}`)
      for (const hop of hops) deps.log(`    ${hop.url} ${hop.status}${hop.location ? ` -> ${hop.location}` : ''} ${JSON.stringify(hop.headers)}`)
    }
    return 0
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    if (outDir && remove) await fsp.rm(outDir, { recursive: true, force: true })
  }
}

/** The real command runner, fetch and paths. */
export function defaultDeps(root: string): MainDeps {
  const run: Run = (command, args) => new Promise(resolve => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
  return { run, fetch: (url, init) => globalThis.fetch(url, init), log: line => console.log(line), error: line => console.error(line), manifest: ASSET_MANIFEST, root, home: os.homedir() }
}
