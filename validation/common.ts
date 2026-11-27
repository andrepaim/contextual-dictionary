// Shared pieces of the stage 3 measurement scripts (docs/validation.md).
// These scripts read local inputs (the Kaikki extract, the real pack, the
// model export) and write their outputs under ~/.cache/contextual-dictionary/
// validation/; nothing they read or write is committed except the item lists
// in validation/data/.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import { senseRequest } from '@andrepaim/contextual-dictionary-core'
import { SELECTION_LIMITS, type ByteSource, type DictionaryResult, type Selection, type SenseFormat } from '../src/shared/contracts'
import { MODEL_SOURCE, defaultHubCache, hubModelDir } from '../scripts/assets-release'

const home = os.homedir()
const expand = (value: string) => value.replace(/^~(?=\/|$)/, home)

export const PATHS = {
  kaikki: expand(process.env.CD_KAIKKI ?? '~/.cache/contextual-dictionary/kaikki/english-2026-10-30.jsonl.gz'),
  simple: expand(process.env.CD_KAIKKI_SIMPLE ?? '~/.cache/contextual-dictionary/kaikki/simple-english-2026-10-30.jsonl.gz'),
  pack: expand(process.env.CD_PACK ?? '~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack'),
  // The model the build pins, as `node scripts/publish-assets.mjs --fetch-model` downloads it, unless CD_MODEL_DIR names another export.
  model: process.env.CD_MODEL_DIR ? expand(process.env.CD_MODEL_DIR) : hubModelDir(defaultHubCache(home), MODEL_SOURCE),
  out: expand(process.env.CD_VALIDATION_OUT ?? '~/.cache/contextual-dictionary/validation'),
}
fs.mkdirSync(PATHS.out, { recursive: true })

export const CAPS = [8, 12, 16, 24, 48] as const
/** The caps evaluated, and the model's own limit (127) as "no cap". */
export const EVAL_CAPS = [...CAPS, 127] as const

/**
 * Ways of building the prompt that are evaluated: a cap on meanings, and
 * optionally a cap on the prompt's length in characters (a stand-in for
 * tokens, which the extension's offscreen document cannot count) and
 * definitions shortened in the prompt only.
 */
export interface Variant { key: string; cap: number; maxChars?: number; shorten?: boolean }
export const VARIANTS: Variant[] = [
  ...EVAL_CAPS.map(cap => ({ key: String(cap), cap })),
  { key: '48|c900', cap: 48, maxChars: 900 },
  { key: '48|c1200', cap: 48, maxChars: 1200 },
  { key: '48|c1600', cap: 48, maxChars: 1600 },
  // The defaults chosen in stage 3: at most 24 meanings and 1,600 characters.
  { key: '24|c1600', cap: 24, maxChars: 1600 },
  { key: '48|s|c1200', cap: 48, maxChars: 1200, shorten: true },
  { key: '16|s', cap: 16, shorten: true },
]

/**
 * A long definition as it could appear in the prompt only: wiktextract's
 * joined gloss levels ("Parent: child") keep the label and the last level,
 * and anything still over 200 characters is cut at a word boundary.
 */
export function shortDefinition(definition: string): string {
  if (definition.length <= 150) return definition
  const label = /^\([^()]*\)\s+/u.exec(definition)?.[0] ?? ''
  const body = definition.slice(label.length)
  const at = body.lastIndexOf(': ')
  let text = at > 0 && body.length - at - 2 >= 25 ? label + body.slice(at + 2) : definition
  if (text.length > 200) text = `${text.slice(0, 200).replace(/\s+\S*$/u, '')}…`
  return text
}

/** senseRequest for one variant; the meanings' indices are those of `result`. */
export function variantRequest(result: DictionaryResult, selection: Selection, format: SenseFormat, variant: Variant) {
  const shown = variant.shorten
    ? { ...result, entries: result.entries.map(entry => ({ ...entry, senses: entry.senses.map(sense => ({ ...sense, definition: shortDefinition(sense.definition) })) })) }
    : result
  // senseRequest bounds the prompt at max_length * 8 characters and drops meanings until it fits.
  const bounded = variant.maxChars ? { ...format, max_length: variant.maxChars / 8 } : format
  return senseRequest(shown, selection, bounded, variant.cap)
}
export const BUDGETS = [250, 350, 500, 750, 1000, 2000] as const

/** A distinct prompt as prompts.jsonl holds it. */
export interface StoredPrompt { hash: string; prompt: string; tokens: number; offered: number }
type BuiltRequest = Exclude<ReturnType<typeof variantRequest>, { skip: unknown }>

/**
 * What an item records for each variant: why no prompt is built, or the
 * prompt's hash, the meanings offered and whether the labelled one is among
 * them. Prompts not seen before are added to `prompts`; `inspect` sees every
 * request that was built.
 */
export function variantPrompts(
  result: DictionaryResult, selection: Selection, labelled: { entry: number; sense: number }, format: SenseFormat,
  tokens: (text: string) => number, prompts: Map<string, StoredPrompt>, inspect?: (request: BuiltRequest) => void,
): Record<string, unknown> {
  const perCap: Record<string, unknown> = {}
  for (const variant of VARIANTS) {
    const request = variantRequest(result, selection, format, variant)
    if ('skip' in request) { perCap[variant.key] = { skip: request.skip }; continue }
    const hash = sha256Hex(request.prompt)
    if (!prompts.has(hash)) prompts.set(hash, { hash, prompt: request.prompt, tokens: tokens(request.prompt), offered: request.candidates.length })
    inspect?.(request)
    perCap[variant.key] = {
      prompt: hash, candidates: request.candidates.map(c => [c.entry, c.sense]),
      labelledOffered: request.candidates.some(c => c.entry === labelled.entry && c.sense === labelled.sense),
    }
  }
  return perCap
}

/** Reads a file by byte range, as the extension reads its stored copy. */
export async function fileSource(file: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await fsp.open(file, 'r')
  const { size } = await handle.stat()
  return {
    size,
    read: async (start, end) => {
      const buffer = new Uint8Array(end - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      return buffer.subarray(0, bytesRead)
    },
    close: () => handle.close(),
  }
}

/** Throws, saying how to get it, when `directory` is not a model export. */
export function requireModel(directory = PATHS.model): string {
  if (fs.existsSync(path.join(directory, 'model_metadata.json'))) return directory
  const how = process.env.CD_MODEL_DIR
    ? 'CD_MODEL_DIR names it: point it at a folder with onnx/model.int8.onnx and the four JSON files, or unset it to use the model the build pins.'
    : `It is the default, the model the build pins (${MODEL_SOURCE.repo} at ${MODEL_SOURCE.revision}): fetch it with \`node scripts/publish-assets.mjs --fetch-model\` (about 207 MB, checked against the pins), or set CD_MODEL_DIR to another model export.`
  throw new Error(`No model export at ${directory}. ${how}`)
}

/** The compact-v1 format as the model worker reports it (src/model/session.ts readFormat). */
export function readFormat(directory = PATHS.model): SenseFormat {
  requireModel(directory)
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'model_metadata.json'), 'utf8'))
  const calibration = JSON.parse(fs.readFileSync(path.join(directory, 'calibration.json'), 'utf8'))
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'tokenizer_config.json'), 'utf8'))
  return {
    letters: metadata.letters, nota_index: metadata.nota_index, none_text: metadata.none_text, separator: metadata.separator,
    mask_token: config.mask_token, max_length: metadata.max_length, temperature: calibration.temperature ?? 1,
  }
}

export function tokenCounter(directory = PATHS.model): (text: string) => number {
  requireModel(directory)
  const tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(directory, 'tokenizer.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(directory, 'tokenizer_config.json'), 'utf8')),
  )
  return text => tokenizer.encode(text).ids.length
}

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

const collapse = (text: string) => text.replace(/\s+/g, ' ')

/**
 * The selection the content script would send for the span [start, end) of a
 * passage: white space collapsed, at most 120 characters on each side
 * (src/content/selection.ts).
 */
export function selectionAt(text: string, start: number, end: number): Selection {
  return {
    text: text.slice(start, end),
    before: collapse(text.slice(0, start)).trimStart().slice(-SELECTION_LIMITS.contextChars),
    after: collapse(text.slice(end)).trimEnd().slice(0, SELECTION_LIMITS.contextChars),
  }
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

export const percentile = (sorted: number[], p: number) => {
  if (!sorted.length) return NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

/**
 * A seeded bootstrap 95% interval of the paired difference `a` minus `b` (2,000 resamples). With `groups`
 * (one key per item), whole groups are resampled together, for items that are not independent (several
 * passages of one headword).
 */
export function pairedInterval(a: number[], b: number[], seed: number, groups?: readonly string[]): [number, number] {
  let state = seed >>> 0 || 1
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32 }
  const n = a.length, diffs: number[] = []
  if (!groups) {
    for (let r = 0; r < 2000; r++) {
      let sum = 0
      for (let i = 0; i < n; i++) { const j = Math.floor(random() * n); sum += a[j]! - b[j]! }
      diffs.push(sum / n)
    }
  } else {
    const members = new Map<string, number[]>()
    groups.forEach((key, i) => members.set(key, [...(members.get(key) ?? []), i]))
    const clusters = [...members.values()]
    for (let r = 0; r < 2000; r++) {
      let sum = 0, count = 0
      for (let c = 0; c < clusters.length; c++) {
        for (const i of clusters[Math.floor(random() * clusters.length)]!) { sum += a[i]! - b[i]!; count++ }
      }
      diffs.push(sum / count)
    }
  }
  diffs.sort((x, y) => x - y)
  return [percentile(diffs, 2.5), percentile(diffs, 97.5)]
}

/** Buckets of meanings offered, as docs/validation.md reports them. */
export const OFFERED_BUCKETS = [[1, 4], [5, 8], [9, 16], [17, 32], [33, Infinity]] as const
/** Strata of meanings in the labelled entry. */
export const ENTRY_BUCKETS = [[2, 2], [3, 4], [5, 8], [9, 16], [17, 32], [33, Infinity]] as const
export const bucketLabel = ([low, high]: readonly [number, number]) => (high === Infinity ? `${low}+` : low === high ? `${low}` : `${low}–${high}`)
export const bucketOf = <B extends readonly (readonly [number, number])[]>(buckets: B, value: number) => buckets.find(([low, high]) => value >= low && value <= high)
