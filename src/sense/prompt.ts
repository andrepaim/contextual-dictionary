import { SETTING_LIMITS, type DictionaryEntry, type DictionaryResult, type Selection, type SenseFormat } from '../shared/contracts'

// Contextual order for the definition card: one prompt that offers the
// meanings of every entry to a word-sense model, and the reordering of its
// answer. Pure functions; the model runs in src/model/, the scheduling in
// ranker.ts. Ported from pdfpal's src/core/sense-order.ts, with a cap on the
// number of meanings offered.

export type SenseTarget = { start: number; end: number; text: string }
export type SenseCandidate = { entry: number; sense: number }
export type SenseRequest = {
  prompt: string
  target: SenseTarget
  /** The meanings offered to the model, in prompt (dictionary) order. Meanings not listed are not scored. */
  candidates: SenseCandidate[]
  /** How many meanings the result has in all. */
  total: number
}
export type SkipReason = 'NO_ENTRIES' | 'SINGLE_SENSES' | 'INVALID_FORMAT' | 'TOO_MANY_SENSES' | 'INVALID_SPAN' | 'UNSAFE_TEXT' | 'NOT_ENGLISH' | 'TOO_LONG'

const isHigh = (unit: string | undefined) => unit !== undefined && /[\uD800-\uDBFF]/.test(unit)
const isLow = (unit: string | undefined) => unit !== undefined && /[\uDC00-\uDFFF]/.test(unit)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// Literal markers the compact prompt uses, and tokens the tokenizer would read as control tokens.
const UNSAFE = /\*|\[(?:MASK|CLS|SEP|PAD|UNK|unused\d+)\]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/**
 * Converts a JavaScript (UTF-16) span of `text` to the model's Unicode code
 * point offsets, end exclusive. Null for an empty span or one that splits a
 * surrogate pair.
 */
export function codePointSpan(text: string, start: number, end: number): SenseTarget | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return null
  for (const offset of [start, end]) if (offset > 0 && offset < text.length && isHigh(text[offset - 1]) && isLow(text[offset])) return null
  return { start: Array.from(text.slice(0, start)).length, end: Array.from(text.slice(0, end)).length, text: text.slice(start, end) }
}

// Very common English function words, and common function words of the
// European languages whose text an English dictionary could otherwise appear
// to match. Words that are also English ("do", "die", "per", "van") are left out.
const ENGLISH = new Set('the of and to in is are was were be been being that this these those for with as by on at from it its we our they their which or not but can has have had an will would should may also than such into between each used using he she his her who there'.split(' '))
const FOREIGN = new Set(('de da das dos que não nao uma um para com por em os ela ele seu sua são é ao à na no' // Portuguese
  + ' el la los las del con y es una lo muy pero más como' // Spanish
  + ' le les et des du est une pour dans sur ce qui pas très avec' // French
  + ' und der das ist nicht mit ein eine zu von dem sich auch wird' // German
  + ' il di che della sono gli' // Italian
  + ' het een zijn niet').split(' ')) // Dutch
// "no" and "na" are also English, but rare in prose next to the words above.
for (const word of ['no', 'na']) FOREIGN.delete(word)

/**
 * A conservative check that a passage is English: Latin script, few
 * accented letters, and English rather than other languages' function words.
 */
export function looksEnglish(passage: string): boolean {
  const letters = passage.match(/\p{L}/gu) ?? []
  if (!letters.length) return false
  const latin = letters.filter(letter => /\p{Script=Latin}/u.test(letter))
  if (latin.length / letters.length < 0.9) return false
  if (latin.filter(letter => !/[a-z]/i.test(letter)).length / latin.length > 0.05) return false
  const words = passage.toLowerCase().match(/\p{L}+/gu) ?? []
  const english = words.filter(word => ENGLISH.has(word)).length
  const foreign = words.filter(word => FOREIGN.has(word)).length
  if (words.length < 6) return foreign === 0
  return english >= 2 && english >= 2 * foreign
}

/** Whether `value` is a usable compact-v1 format: a letter for every candidate and for "none of the above". */
export function isSenseFormat(value: unknown): value is SenseFormat {
  if (typeof value !== 'object' || value === null) return false
  const format = value as Record<string, unknown>
  const text = (key: string) => typeof format[key] === 'string' && (format[key] as string).length > 0
  return Array.isArray(format.letters) && format.letters.every(letter => typeof letter === 'string' && letter.length > 0)
    && Number.isInteger(format.nota_index) && (format.nota_index as number) >= 2 && format.letters.length > (format.nota_index as number)
    && text('none_text') && text('separator') && text('mask_token')
    && typeof format.max_length === 'number' && format.max_length > 0 && typeof format.temperature === 'number' && Number.isFinite(format.temperature)
}

/**
 * The most meanings one prompt may offer: `maxCandidates` kept between the
 * smallest useful number (2) and the model's own limit (every letter before
 * "none of the above"). A missing or unusable value means the model's limit.
 */
function candidateLimit(format: SenseFormat, maxCandidates: number | undefined): number {
  const model = format.nota_index
  if (maxCandidates === undefined || !Number.isFinite(maxCandidates)) return model
  return Math.min(model, Math.max(SETTING_LIMITS.maxCandidates.min, Math.floor(maxCandidates)))
}

/**
 * Up to `limit` meanings in the order they are offered: round-robin by entry
 * in dictionary order. Round 0 takes the first meaning of every entry, round
 * 1 the second meaning of every entry that has one, and so on, so an entry
 * with 100 meanings cannot crowd out the next part of speech, and room an
 * exhausted entry leaves goes to the others. Each entry contributes its first
 * meanings in dictionary order.
 */
function roundRobin(entries: DictionaryEntry[], limit: number): SenseCandidate[] {
  const picks: SenseCandidate[] = []
  for (let sense = 0; picks.length < limit; sense++) {
    const before = picks.length
    for (let entry = 0; entry < entries.length && picks.length < limit; entry++) {
      if (sense < entries[entry]!.senses.length) picks.push({ entry, sense })
    }
    if (picks.length === before) break
  }
  return picks
}

/** Whether some entry has at least two offered meanings, the least that lets an order change. */
function canReorder(candidates: SenseCandidate[]): boolean {
  const seen = new Set<number>()
  for (const { entry } of candidates) {
    if (seen.has(entry)) return true
    seen.add(entry)
  }
  return false
}

const dictionaryOrder = (a: SenseCandidate, b: SenseCandidate) => a.entry - b.entry || a.sense - b.sense

/**
 * The single prompt that scores the meanings of every entry on the selected
 * span, or why the lookup is not scored. `text` is the selection as made;
 * its surrounding whitespace only separates it from `before` and `after`.
 *
 * At most `maxCandidates` meanings are offered (see `roundRobin` for which),
 * and fewer when the prompt would exceed the length bound; the rest keep
 * dictionary order after the scored ones (`contextualOrder`).
 */
export function senseRequest(result: DictionaryResult, selection: Selection, format: SenseFormat, maxCandidates?: number): SenseRequest | { skip: SkipReason } {
  if (!result.entries.length) return { skip: 'NO_ENTRIES' }
  if (result.entries.every(entry => entry.senses.length < 2)) return { skip: 'SINGLE_SENSES' }
  if (!isSenseFormat(format)) return { skip: 'INVALID_FORMAT' }
  const total = result.entries.reduce((sum, entry) => sum + entry.senses.length, 0)
  const picks = roundRobin(result.entries, candidateLimit(format, maxCandidates))
  if (!canReorder(picks)) return { skip: 'TOO_MANY_SENSES' }

  const selected = selection.text.trim().replace(/\s+/g, ' ')
  if (!selected) return { skip: 'INVALID_SPAN' }
  let before = selection.before ?? '', after = selection.after ?? ''
  // The context is cut at a fixed length, which can leave half of a surrogate pair at its outer edge.
  if (isLow(before[0])) before = before.slice(1)
  if (isHigh(after.at(-1))) after = after.slice(0, -1)
  const leading = /^\s/.test(selection.text) ? ' ' : '', trailing = /\s$/.test(selection.text) ? ' ' : ''
  const pre = (before + leading).replace(/\s+/g, ' ').trimStart()
  const post = (trailing + after).replace(/\s+/g, ' ').trimEnd()
  const passage = pre + selected + post
  if (LONE_SURROGATE.test(passage)) return { skip: 'INVALID_SPAN' }
  const target = codePointSpan(passage, pre.length, pre.length + selected.length)
  if (!target) return { skip: 'INVALID_SPAN' }

  const definition = ({ entry, sense }: SenseCandidate) => result.entries[entry]!.senses[sense]!.definition
  // Only the definitions that may be offered reach the model, so only they are checked.
  for (const content of [passage, ...picks.map(definition)]) {
    if (UNSAFE.test(content) || content.includes(format.mask_token) || content.includes(format.separator)) return { skip: 'UNSAFE_TEXT' }
  }
  if (!looksEnglish(passage)) return { skip: 'NOT_ENGLISH' }

  const points = Array.from(passage)
  const marked = points.slice(0, target.start).join('') + '*' + target.text + '*' + points.slice(target.end).join('')
  const none = `${format.letters[format.nota_index]}. ${format.none_text}`
  // Every token is at least one character, so a longer prompt cannot fit; the worker checks tokens.
  const bound = format.max_length * 8
  // Too long: drop the last meaning of the round-robin order and try again, while some entry keeps two.
  for (let count = picks.length; count >= 2; count--) {
    const candidates = picks.slice(0, count).sort(dictionaryOrder)
    if (!canReorder(candidates)) break
    const choices = candidates.map((candidate, i) => `${format.letters[i]}. ${definition(candidate)}`)
    const prompt = `${marked}\n${choices.join('\n')}\n${none}\n${format.separator} ${format.mask_token}`
    if (prompt.length <= bound) return { prompt, target, candidates, total }
  }
  return { skip: 'TOO_LONG' }
}

export type OrderOutcome = { result: DictionaryResult; applied: true } | { result: DictionaryResult; applied: false; reason: 'NONE_FITS' | 'INVALID_SCORES' }

/**
 * Sorts the scored meanings of each entry by the model's probability,
 * highest first; meanings that were not offered follow in dictionary order.
 * Entries keep their order and the sort is stable, so equal scores keep
 * dictionary order. When "none of the above" scores at least as high as
 * every meaning, or the scores are unusable, `result` itself is returned.
 */
export function contextualOrder(result: DictionaryResult, request: SenseRequest, logits: ArrayLike<number>, format: SenseFormat): OrderOutcome {
  const count = request.candidates.length
  if (logits.length <= format.nota_index || count === 0 || count > format.nota_index) return { result, applied: false, reason: 'INVALID_SCORES' }
  const temperature = format.temperature > 0 ? format.temperature : 1
  const scores = [...Array.from({ length: count }, (_, i) => logits[i]!), logits[format.nota_index]!].map(value => value / temperature)
  if (!scores.every(Number.isFinite)) return { result, applied: false, reason: 'INVALID_SCORES' }
  const maximum = Math.max(...scores)
  const exp = scores.map(value => Math.exp(value - maximum)), total = exp.reduce((sum, value) => sum + value, 0)
  const probabilities = exp.map(value => value / total)
  const none = probabilities.pop()!
  if (none >= Math.max(...probabilities)) return { result, applied: false, reason: 'NONE_FITS' }

  const probability = new Map(request.candidates.map((candidate, i) => [`${candidate.entry}:${candidate.sense}`, probabilities[i]!]))
  const entries = result.entries.map((entry, e) => {
    const scored: Array<{ sense: (typeof entry.senses)[number]; s: number; p: number }> = []
    const rest: typeof entry.senses = []
    entry.senses.forEach((sense, s) => {
      const p = probability.get(`${e}:${s}`)
      if (p === undefined) rest.push(sense)
      else scored.push({ sense, s, p })
    })
    scored.sort((a, b) => b.p - a.p || a.s - b.s)
    return { ...entry, senses: [...scored.map(({ sense }) => sense), ...rest] }
  })
  return { result: { ...result, entries }, applied: true }
}
