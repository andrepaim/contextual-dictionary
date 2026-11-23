// Turns one Kaikki wiktextract record (one part of speech of one Wiktionary
// page) into a pack entry, applying the dictionary scope of docs/plan.md:
// every part of speech except proper names and single characters or symbols;
// inflection senses (those with form_of) become pointers to their base word;
// at most two short examples per meaning, usage examples before quotations;
// empty glosses dropped; leftover wiki and HTML markup removed. Pure functions,
// used by scripts/build-dictionary.ts.
import { normalizeKey } from './keys'
import type { PackEntry, PackPointer, PackSense } from './pack-format'

export interface ScopeOptions {
  /** Examples kept per meaning. */
  maxExamples: number
  /** Longest example kept, in characters, after white space is collapsed. */
  maxExampleChars: number
  /** Put a gloss's leading qualifier, such as "(transitive)", in front of the definition. */
  labels: boolean
  /** Kaikki parts of speech left out. */
  excludedPos: string[]
}

export const DEFAULT_SCOPE: ScopeOptions = {
  maxExamples: 2,
  maxExampleChars: 240,
  labels: true,
  excludedPos: ['name', 'character', 'symbol', 'punct'],
}

export interface KaikkiExample { text?: unknown; ref?: unknown; type?: unknown }
export interface KaikkiSense {
  glosses?: unknown[]
  raw_glosses?: unknown[]
  examples?: unknown[]
  form_of?: unknown[]
  tags?: unknown[]
}

export type SkipReason = 'no-word' | 'no-pos' | 'not-english' | 'excluded-pos' | 'no-letter' | 'no-senses'

export type Transformed =
  | { ok: true; key: string; entry: PackEntry; droppedSenses: number; cleanedGlosses: number }
  | { ok: false; reason: SkipReason }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const collapse = (text: string) => text.replace(/\s+/gu, ' ').trim()

const HTML_TAG = /<\/?(?:sup|sub|span|small|big|i|b|u|s|em|strong|code|abbr|nowiki|ref|div|font|q|var|bdi|mark)\b[^<>]*>/giu
const BREAK_TAG = /<br\s*\/?>/giu
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Removes wiki and HTML markup that wiktextract left in a gloss: templates
 * `{{…}}` (and the opening of an unclosed one), links `[[target|text]]`,
 * formatting tags, bold and italic quotes, a few entities. Text that only
 * looks like markup ("a < b", "Procter & Gamble", primes in formulas) stays.
 */
export function cleanMarkup(text: string): string {
  let out = text
  // Templates, innermost first; then an unclosed opening such as "{{n-g|".
  for (let previous = ''; previous !== out;) { previous = out; out = out.replace(/\{\{[^{}]*\}\}/gu, '') }
  out = out.replace(/\{\{(?:[^{}|]*\|)?/gu, '').replace(/\}\}/gu, '')
  // Links: [[target]], [[target|text]], [[target#Section|]].
  out = out.replace(/\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/gu, (_, target: string, label: string | undefined) => (label ? label : target.split('#')[0]!))
  out = out.replace(/\[\[|\]\]/gu, '')
  out = out.replace(BREAK_TAG, ' ').replace(HTML_TAG, '')
  // '''bold''' and ''italic'', only as whole words so primes in formulas stay.
  out = out.replace(/(^|[\s([“"])('{2,3})([^'\n]+?)\2(?=$|[\s).,;:!?\]”"])/gu, '$1$3')
  out = out.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|(nbsp|amp|lt|gt|quot|apos));/giu, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return ENTITIES[name.toLowerCase()]!
    const code = decimal ? Number(decimal) : Number.parseInt(hex!, 16)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
  return collapse(out)
}

const ELLIPSIS_END = /\s*(?:\.\.\.|…)$/u
const ELLIPSIS_START = /^(?:\.\.\.|…)\s*/u

/**
 * One definition from wiktextract's gloss levels, where each later level is
 * a sub-meaning of the one before. A level that repeats its parent stands
 * alone; one that starts with an ellipsis continues its parent's sentence;
 * otherwise it follows its parent after a colon.
 */
export function joinGlosses(levels: string[]): string {
  let text = ''
  for (const raw of levels) {
    const level = collapse(raw)
    if (!level) continue
    if (!text) { text = level; continue }
    if (ELLIPSIS_START.test(level)) text = `${text.replace(ELLIPSIS_END, '')} ${level.replace(ELLIPSIS_START, '')}`
    else if (level.startsWith(text.replace(/[.:;]+$/u, ''))) text = level
    else text = `${text.replace(/[.:;]+$/u, '')}: ${level}`
  }
  return text
}

/** The definition of a sense, or undefined when it has no gloss left. */
export function senseText(sense: KaikkiSense, labels: boolean): string | undefined {
  const glosses = strings(sense.glosses).map(cleanMarkup).filter(Boolean)
  if (!glosses.length) return undefined
  let text = joinGlosses(glosses)
  if (labels) {
    // wiktextract keeps qualifiers such as "(transitive)" only in raw_glosses.
    const raw = strings(sense.raw_glosses).at(-1)
    const label = raw === undefined ? null : /^\(([^()]+)\)\s+(.*)$/su.exec(cleanMarkup(raw))
    if (label && label[2]!.startsWith(glosses.at(-1)!)) text = `(${label[1]}) ${text}`
  }
  return text
}

/** Up to `maxExamples` examples no longer than `maxExampleChars`: usage examples first, then quotations. */
export function pickExamples(examples: unknown, options: Pick<ScopeOptions, 'maxExamples' | 'maxExampleChars'>): string[] {
  if (!Array.isArray(examples) || options.maxExamples <= 0) return []
  const usage: string[] = [], quotations: string[] = []
  for (const example of examples) {
    if (!isObject(example) || typeof example.text !== 'string') continue
    const text = collapse(example.text)
    if (!text || text.length > options.maxExampleChars) continue
    const isQuotation = example.type === 'quotation' || (example.type !== 'example' && example.ref !== undefined)
    ;(isQuotation ? quotations : usage).push(text)
  }
  return [...new Set([...usage, ...quotations])].slice(0, options.maxExamples)
}

/** The base word of an inflection sense, if it is one. */
function formOf(sense: KaikkiSense): string | undefined {
  for (const item of Array.isArray(sense.form_of) ? sense.form_of : []) {
    if (isObject(item) && typeof item.word === 'string' && item.word.trim()) return item.word.trim()
  }
  return undefined
}

/** One Kaikki record as a pack entry and its key, or why it is left out. */
export function transformEntry(raw: unknown, scope: ScopeOptions): Transformed {
  if (!isObject(raw) || typeof raw.word !== 'string' || !raw.word.trim()) return { ok: false, reason: 'no-word' }
  if (typeof raw.pos !== 'string' || !raw.pos) return { ok: false, reason: 'no-pos' }
  if (raw.lang_code !== undefined && raw.lang_code !== 'en') return { ok: false, reason: 'not-english' }
  if (scope.excludedPos.includes(raw.pos)) return { ok: false, reason: 'excluded-pos' }
  const word = raw.word.trim()
  if (!/\p{L}/u.test(word)) return { ok: false, reason: 'no-letter' }

  const senses: PackSense[] = []
  const pointers: PackPointer[] = []
  let droppedSenses = 0, cleanedGlosses = 0
  for (const sense of Array.isArray(raw.senses) ? raw.senses : []) {
    if (!isObject(sense)) { droppedSenses++; continue }
    const text = senseText(sense, scope.labels)
    if (!text) { droppedSenses++; continue }
    const base = formOf(sense)
    if (base !== undefined) {
      if (!pointers.some(pointer => pointer.l === base && pointer.n === text)) pointers.push({ l: base, n: text })
      continue
    }
    if (strings(sense.glosses).some(gloss => cleanMarkup(gloss) !== collapse(gloss))) cleanedGlosses++
    const examples = pickExamples(sense.examples, scope)
    senses.push(examples.length ? [text, ...examples] : text)
  }
  if (!senses.length && !pointers.length) return { ok: false, reason: 'no-senses' }
  const entry: PackEntry = { w: word, p: raw.pos }
  if (senses.length) entry.s = senses
  if (pointers.length) entry.f = pointers
  return { ok: true, key: normalizeKey(word), entry, droppedSenses, cleanedGlosses }
}
