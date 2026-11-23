// Pure helpers of the Wiktionary-derived evaluation set: which meanings of a
// Kaikki record the pack keeps (and at which index), where the headword
// occurs in a usage example, and which examples are used. Tested in
// test/unit/validation/wiktionary-items.test.ts.
import { DEFAULT_SCOPE, senseText, type KaikkiSense } from '../src/dict/kaikki'
import { suffixCandidates } from '../src/dict/lookup'

export interface KaikkiExampleLike { text?: unknown; ref?: unknown; type?: unknown; bold_text_offsets?: unknown }

/** The meanings of a record as the pack stores them: definition text and the Kaikki sense each comes from. */
export function keptSenses(senses: unknown): Array<{ definition: string; kaikkiIndex: number; examples: KaikkiExampleLike[] }> {
  const out: Array<{ definition: string; kaikkiIndex: number; examples: KaikkiExampleLike[] }> = []
  if (!Array.isArray(senses)) return out
  senses.forEach((sense: unknown, kaikkiIndex) => {
    if (typeof sense !== 'object' || sense === null || Array.isArray(sense)) return
    const text = senseText(sense as KaikkiSense, DEFAULT_SCOPE.labels)
    if (!text) return
    // Same test as formOf in src/dict/kaikki.ts: such a sense becomes an inflection pointer.
    const formOf = (sense as KaikkiSense).form_of
    if (Array.isArray(formOf) && formOf.some(item => typeof item === 'object' && item !== null && typeof (item as { word?: unknown }).word === 'string' && (item as { word: string }).word.trim())) return
    const examples = Array.isArray((sense as KaikkiSense).examples) ? (sense as KaikkiSense).examples as KaikkiExampleLike[] : []
    out.push({ definition: text, kaikkiIndex, examples })
  })
  return out
}

/** The year a quotation's reference starts with ("2013 June 1, …", "c. 1600, …"), if any. */
export function quotationYear(ref: unknown): number | undefined {
  if (typeof ref !== 'string') return undefined
  const match = /^\s*(?:c\.\s*|circa\s+|a\.\s*|ca\.\s*)?(\d{3,4})(?!\d)/u.exec(ref)
  return match ? Number(match[1]) : undefined
}

const TOKEN = /\p{L}+/gu

/** Whether `token` is `word` or an inflected form of it. */
export function isFormOf(token: string, word: string, forms: ReadonlySet<string>): boolean {
  const lower = token.toLowerCase()
  return lower === word || forms.has(lower) || suffixCandidates(lower).includes(word)
}

/** UTF-16 offset of a code point offset (wiktextract counts code points). */
function utf16Offset(text: string, codePoints: number): number | undefined {
  let units = 0, points = 0
  for (const char of text) {
    if (points === codePoints) return units
    units += char.length
    points++
  }
  return points === codePoints ? units : undefined
}

/** A token is usable when it is not part of a hyphenated or apostrophised word. */
function standsAlone(text: string, start: number, end: number): boolean {
  const before = text[start - 1], after = text[end]
  return !(before && /[\p{L}\p{N}'’‐‑-]/u.test(before)) && !(after && /[\p{L}\p{N}'’‐‑-]/u.test(after))
}

/**
 * Where the headword (or an inflected form) occurs in an example, as a UTF-16
 * span. The example's bold span is used when it has one (the editors' own
 * marking of the headword); otherwise the first standalone form of the word.
 */
export function findOccurrence(example: KaikkiExampleLike, word: string, forms: ReadonlySet<string>): { start: number; end: number } | undefined {
  if (typeof example.text !== 'string') return undefined
  const text = example.text
  const bold = Array.isArray(example.bold_text_offsets) ? example.bold_text_offsets : []
  if (bold.length) {
    for (const pair of bold) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isSafeInteger)) continue
      const start = utf16Offset(text, pair[0] as number), end = utf16Offset(text, pair[1] as number)
      if (start === undefined || end === undefined || end <= start) continue
      const span = text.slice(start, end)
      const tokens = span.match(TOKEN) ?? []
      if (tokens.length !== 1) continue
      const at = start + span.indexOf(tokens[0]!)
      const stop = at + tokens[0]!.length
      if (isFormOf(tokens[0]!, word, forms) && standsAlone(text, at, stop)) return { start: at, end: stop }
    }
    return undefined
  }
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index!, end = start + match[0].length
    if (isFormOf(match[0], word, forms) && standsAlone(text, start, end)) return { start, end }
  }
  return undefined
}

export type ExampleVerdict = { ok: true; start: number; end: number; year?: number } | { ok: false; reason: 'no-text' | 'archaic' | 'short' | 'no-occurrence' }

/** Whether an example can be an item: modern enough, long enough, with the word in it. */
export function judgeExample(example: KaikkiExampleLike, word: string, forms: ReadonlySet<string>, options = { minYear: 1900, minWords: 6 }): ExampleVerdict {
  if (typeof example.text !== 'string' || !example.text.trim()) return { ok: false, reason: 'no-text' }
  const quotation = example.type === 'quotation' || (example.type !== 'example' && example.ref !== undefined)
  const year = quotation ? quotationYear(example.ref) : undefined
  if (year !== undefined && year < options.minYear) return { ok: false, reason: 'archaic' }
  if ((example.text.match(TOKEN) ?? []).length < options.minWords) return { ok: false, reason: 'short' }
  const span = findOccurrence(example, word, forms)
  if (!span) return { ok: false, reason: 'no-occurrence' }
  return year === undefined ? { ok: true, ...span } : { ok: true, ...span, year }
}
