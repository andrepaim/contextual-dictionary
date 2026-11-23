// The pinned description of everything the extension can download: one
// release of this repository, two bundles, and per file the bytes that are
// transferred (`name`, `size`, `sha256`) and the file as it is kept after an
// optional gunzip (`storedName`, `storedSize`, `storedSha256`).
//
// A pin that is not known yet is null. A bundle can be downloaded only when
// every pin of every file is filled in; until then the service reports it
// with DOWNLOAD_UNAVAILABLE. Published assets never change: a new payload
// gets a new release tag and new pins.

import { CodedError, type BundleName } from '../shared/contracts'
import { isSafeName } from './file-store'

export type Encoding = 'identity' | 'gzip'

export interface ManifestFile {
  /** The published file name in the release, also the last segment of its URL. */
  name: string
  /** Bytes transferred; null until published. */
  size: number | null
  /** SHA-256 (lower-case hex) of the bytes transferred; null until published. */
  sha256: string | null
  /** The file name in the extension's storage. */
  storedName: string
  storedSize: number | null
  storedSha256: string | null
  /** `gzip`: the transfer is a gzip of the stored file. `identity`: they are the same bytes. */
  encoding: Encoding
}

/** A file with every pin known. */
export interface PinnedFile extends ManifestFile { size: number; sha256: string; storedSize: number; storedSha256: string }

export interface AssetManifest {
  /** The release tag, for example `assets-v1`. */
  tag: string
  /** Release downloads live at `${baseUrl}/${tag}/${name}`. No trailing slash. */
  baseUrl: string
  bundles: Record<BundleName, ManifestFile[]>
}

/** Stored names the other modules open. */
export const STORED_NAMES = {
  dictionary: 'wiktionary-en-v1.pack',
  model: 'ettin-150m-wsd-int8.onnx',
  modelMetadata: 'model_metadata.json',
  calibration: 'calibration.json',
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
} as const

/**
 * The release this build downloads. The publishing task fills in every null:
 * the transfer `size` and `sha256` of each file, and the dictionary's stored
 * pins (equal to its transfer pins, since it is sent as is).
 */
export const ASSET_MANIFEST: AssetManifest = {
  tag: 'assets-v1',
  baseUrl: 'https://github.com/andrepaim/contextual-dictionary/releases/download',
  bundles: {
    dictionary: [
      { name: 'wiktionary-en-v1.pack', size: null, sha256: null, storedName: STORED_NAMES.dictionary, storedSize: null, storedSha256: null, encoding: 'identity' },
    ],
    // Stored pins: Ettin-150m-WSD dynamic INT8 ONNX, revision 8751b577199d1bb95b74fa2457da7065d57100ae.
    model: [
      { name: 'ettin-150m-wsd-int8.onnx.gz', size: null, sha256: null, storedName: STORED_NAMES.model, storedSize: 266954889, storedSha256: '8649a1139b81a56b16ec6853d6127882a1b9539a4c33c09e3fce93ab62822d68', encoding: 'gzip' },
      { name: 'model_metadata.json', size: null, sha256: null, storedName: STORED_NAMES.modelMetadata, storedSize: 1552, storedSha256: '7a07cdd82572cada84061c1cdb61670b2d220d9cc422397d18244874d9fb7707', encoding: 'identity' },
      { name: 'calibration.json', size: null, sha256: null, storedName: STORED_NAMES.calibration, storedSize: 101, storedSha256: '84f67365897b09a6d6b7d2289f16dd6582d07e7e6e0f1b2094491a72b636d8ab', encoding: 'identity' },
      { name: 'tokenizer.json', size: null, sha256: null, storedName: STORED_NAMES.tokenizer, storedSize: 3583228, storedSha256: '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30', encoding: 'identity' },
      { name: 'tokenizer_config.json', size: null, sha256: null, storedName: STORED_NAMES.tokenizerConfig, storedSize: 487, storedSha256: 'd0ec2c8141eec0fa98e31a43c3a453f9c40dcde862762762b0f1898bfb793183', encoding: 'identity' },
    ],
  },
}

export const BUNDLE_NAMES: readonly BundleName[] = ['dictionary', 'model']

export const isPinned = (file: ManifestFile): file is PinnedFile =>
  file.size !== null && file.sha256 !== null && file.storedSize !== null && file.storedSha256 !== null

/** Every file of `bundle` with its pins, or undefined while any pin is missing. */
export function publishedFiles(manifest: AssetManifest, bundle: BundleName): PinnedFile[] | undefined {
  const files = manifest.bundles[bundle]
  return files.every(isPinned) ? files : undefined
}

export const fileUrl = (manifest: AssetManifest, file: ManifestFile) => `${manifest.baseUrl}/${manifest.tag}/${encodeURIComponent(file.name)}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isSize = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) > 0)
const isDigest = (value: unknown) => value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function baseUrlProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'baseUrl is not a string'
  let url: URL
  try { url = new URL(value) } catch { return 'baseUrl is not a URL' }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return 'baseUrl must be https (or http on a loopback host)'
  if (url.username || url.password || url.search || url.hash || value.endsWith('/')) return 'baseUrl must have no credentials, query, fragment or trailing slash'
  return undefined
}

function fileProblems(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where} is not an object`]
  const problems: string[] = []
  if (!isSafeName(value.name)) problems.push(`${where}.name is not a safe file name`)
  if (!isSafeName(value.storedName)) problems.push(`${where}.storedName is not a safe file name`)
  if (value.encoding !== 'identity' && value.encoding !== 'gzip') problems.push(`${where}.encoding must be identity or gzip`)
  for (const key of ['size', 'storedSize']) if (!isSize(value[key])) problems.push(`${where}.${key} must be a positive integer or null`)
  for (const key of ['sha256', 'storedSha256']) if (!isDigest(value[key])) problems.push(`${where}.${key} must be 64 lower-case hex digits or null`)
  if ((value.size === null) !== (value.sha256 === null)) problems.push(`${where} has only one of size and sha256`)
  if ((value.storedSize === null) !== (value.storedSha256 === null)) problems.push(`${where} has only one of storedSize and storedSha256`)
  if (value.size !== null && value.storedSize === null) problems.push(`${where} has transfer pins without stored pins`)
  if (value.encoding === 'identity') {
    if (value.name !== value.storedName) problems.push(`${where} is sent as is, so name and storedName must be equal`)
    if (value.size !== null && value.storedSize !== null && (value.size !== value.storedSize || value.sha256 !== value.storedSha256)) problems.push(`${where} is sent as is, so its transfer and stored pins must be equal`)
  }
  return problems
}

/** What is wrong with `value` as an asset manifest; empty when it is valid. */
export function manifestProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['the manifest is not an object']
  const problems: string[] = []
  if (!isSafeName(value.tag)) problems.push('tag is not a safe name')
  const base = baseUrlProblem(value.baseUrl)
  if (base) problems.push(base)
  const bundles = value.bundles
  if (!isRecord(bundles)) return [...problems, 'bundles is not an object']
  const extra = Object.keys(bundles).filter(key => !(BUNDLE_NAMES as readonly string[]).includes(key))
  if (extra.length) problems.push(`unknown bundles: ${extra.join(', ')}`)
  const names = new Set<string>(), storedNames = new Set<string>()
  for (const bundle of BUNDLE_NAMES) {
    const files = bundles[bundle]
    if (!Array.isArray(files) || files.length === 0) { problems.push(`bundle ${bundle} must list at least one file`); continue }
    files.forEach((file, index) => {
      const where = `${bundle}[${index}]`
      const found = fileProblems(file, where)
      problems.push(...found)
      if (found.length) return
      const { name, storedName } = file as ManifestFile
      if (names.has(name)) problems.push(`${where}.name is used twice`)
      if (storedNames.has(storedName)) problems.push(`${where}.storedName is used twice`)
      names.add(name)
      storedNames.add(storedName)
    })
  }
  return problems
}

/** `value` when it is a valid manifest; otherwise throws MANIFEST_INVALID. */
export function assertManifest(value: unknown): AssetManifest {
  const problems = manifestProblems(value)
  if (problems.length) throw new CodedError('MANIFEST_INVALID', `Invalid asset manifest: ${problems.join('; ')}`, { problems })
  return value as AssetManifest
}
