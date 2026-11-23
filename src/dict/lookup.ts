// The Dictionary over a Wiktionary pack. define(selection) lists, in order:
// the longest compound around the selection that is an entry (up to four
// words, from the text before and after it), then the selection itself, its
// own entries ranked by spelling (as selected, then lower case, then other
// spellings) with inflection pointers replaced by their base word's entries
// and a note such as "plural of mouse". Only when the word has no record at
// all, conservative English suffix stripping is tried. Runs in the browser.
import { SELECTION_LIMITS, type ByteSource, type Dictionary, type DictionaryEntry, type DictionaryResult, type DictionarySense, type DictionarySource, type Selection } from '../shared/contracts'
import { normalizeKey } from './keys'
import type { PackEntry, PackPointer, PackRecord, PackSense } from './pack-format'
import { PackReader, type PackReaderOptions } from './pack-reader'

export const WIKTIONARY_NAME = 'Wiktionary'
export const WIKTIONARY_LICENSE = 'CC BY-SA 4.0'

/** The Wiktionary page for a headword. */
export function wiktionaryUrl(word: string): string {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(word.replace(/ /g, '_'))}`
}

/** Where records come from; a PackReader, or a fake in tests. */
export interface RecordSource { get(key: string): Promise<PackRecord | undefined> }

export interface WiktionaryDictionaryOptions {
  /** Longest compound looked for around the selection, in words. Default 4. */
  maxCompoundWords?: number
  /** How many inflection pointers are followed one after another. Default 3. */
  maxPointerDepth?: number
}

/** Words of context on each side that may join a compound. */
const MAX_CONTEXT_WORDS = 3
const ENDS_CLAUSE = /[.,;:!?)\]]$/u
const STARTS_CLAUSE = /^[([]/u
const MIN_STRIP_LENGTH = 4
const CONSONANT_PAIR = /([b-df-hj-np-tv-z])\1$/u

/** A word as selected without the punctuation around it; apostrophes stay ("'tis", "dogs'"). */
function cleanWord(chunk: string): string {
  return chunk.normalize('NFC').replace(/[‘’ʼ＇]/gu, "'").replace(/[‐‑]/gu, '-')
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
}

const chunks = (text: string) => text.split(/\s+/u).filter(Boolean)
const toSense = (sense: PackSense): DictionarySense => (typeof sense === 'string' ? { definition: sense, examples: [] } : { definition: sense[0], examples: sense.slice(1) })

/** Base forms a regular English inflection could come from, most likely first. */
export function suffixCandidates(word: string): string[] {
  if (word.length < MIN_STRIP_LENGTH || !/^[\p{L}'-]+$/u.test(word)) return []
  const out: string[] = []
  const add = (stem: string) => { if (stem.length >= 2 && stem !== word && !out.includes(stem)) out.push(stem) }
  const strip = (ending: string, replacements: string[], undouble = false) => {
    if (!word.endsWith(ending)) return
    const stem = word.slice(0, -ending.length)
    for (const replacement of replacements) add(stem + replacement)
    if (undouble && CONSONANT_PAIR.test(stem)) add(stem.slice(0, -1))
  }
  strip("'s", [''])
  strip('ies', ['y'])
  if (/(?:s|x|z|ch|sh)es$/u.test(word)) strip('es', [''])
  if (!word.endsWith('ss') && !word.endsWith("'s")) strip('s', [''])
  strip('ied', ['y'])
  strip('ed', ['', 'e'], true)
  strip('ing', ['', 'e'], true)
  strip('ier', ['y'])
  strip('iest', ['y'])
  strip('er', ['', 'e'], true)
  strip('est', ['', 'e'], true)
  return out
}

/** A result entry with where it came from, so duplicates can be merged. */
interface Found { id: string; entry: DictionaryEntry }

export class WiktionaryDictionary implements Dictionary {
  private readonly maxCompoundWords: number
  private readonly maxPointerDepth: number

  constructor(private readonly records: RecordSource, options: WiktionaryDictionaryOptions = {}) {
    this.maxCompoundWords = options.maxCompoundWords ?? SELECTION_LIMITS.definableWords
    this.maxPointerDepth = options.maxPointerDepth ?? 3
  }

  async define(selection: Selection): Promise<DictionaryResult> {
    const selected = chunks(selection.text)
    const selectedWords = selected.map(cleanWord).filter(Boolean)
    const result = (query: string, found: Found[]): DictionaryResult => {
      const entries = found.map(item => item.entry)
      return { query, entries, source: { name: WIKTIONARY_NAME, license: WIKTIONARY_LICENSE, url: wiktionaryUrl(entries[0]?.lemma ?? query) } satisfies DictionarySource }
    }
    if (!selectedWords.length || selectedWords.length > SELECTION_LIMITS.definableWords || !selectedWords.some(word => /\p{L}/u.test(word)))
      return result(selectedWords.join(' ') || selection.text.trim(), [])

    const before = chunks(selection.before), after = chunks(selection.after)
    // No space between the selection and its neighbour means the selection
    // stops inside a word: double-clicking "well-known" selects one half.
    const whole = [...selected]
    if (before.length && !/\s$/u.test(selection.before) && !/^\s/u.test(selection.text)) whole[0] = before.pop()! + whole[0]!
    if (after.length && !/\s$/u.test(selection.text) && !/^\s/u.test(selection.after)) whole[whole.length - 1] += after.shift()!
    const words = whole.map(cleanWord).filter(Boolean)

    const found: Found[] = []
    const add = (items: Found[]) => {
      for (const item of items) {
        const known = found.find(other => other.id === item.id)
        if (!known) found.push(item)
        else if (item.entry.note && known.entry.note !== item.entry.note) known.entry.note = known.entry.note ? `${known.entry.note}; ${item.entry.note}` : item.entry.note
      }
    }

    // The longest run of words around the selection that is an entry.
    const left: string[] = [], right: string[] = []
    if (!STARTS_CLAUSE.test(whole[0]!)) {
      for (const chunk of before.reverse().slice(0, MAX_CONTEXT_WORDS)) {
        const word = cleanWord(chunk)
        if (!word || ENDS_CLAUSE.test(chunk)) break
        left.unshift(word)
        if (STARTS_CLAUSE.test(chunk)) break
      }
    }
    if (!ENDS_CLAUSE.test(whole.at(-1)!)) {
      for (const chunk of after.slice(0, MAX_CONTEXT_WORDS)) {
        const word = cleanWord(chunk)
        if (!word || STARTS_CLAUSE.test(chunk)) break
        right.push(word)
        if (ENDS_CLAUSE.test(chunk)) break
      }
    }
    compounds: for (let size = Math.min(this.maxCompoundWords, left.length + words.length + right.length); size > words.length; size--) {
      for (let fromLeft = Math.min(left.length, size - words.length); fromLeft >= 0; fromLeft--) {
        const fromRight = size - words.length - fromLeft
        if (fromRight > right.length) continue
        const compound = await this.lookup([...left.slice(left.length - fromLeft), ...words, ...right.slice(0, fromRight)].join(' '))
        if (compound.length) { add(compound); break compounds }
      }
    }

    let query = words.join(' ')
    let direct = await this.word(query, words.length === 1)
    const completed = query !== selectedWords.join(' ')
    if (completed && !direct.length) {
      // The context was wrong about where the word ends; define what was selected.
      query = selectedWords.join(' ')
      direct = await this.word(query, selectedWords.length === 1)
    }
    add(direct)
    if (words.length === 1) {
      const parts = words[0]!.split('-').filter(part => part.length > 1)
      // Clicking one half of "well-known" lists the whole word, then that half.
      if (completed && direct.length && parts.includes(selectedWords[0]!)) add(await this.word(selectedWords[0]!, true))
      // A hyphenated word without an entry falls back to its parts, the last first.
      else if (!direct.length && parts.length > 1) for (const part of parts.reverse()) add(await this.word(part, true))
    }
    return result(query, found)
  }

  /** A word or phrase: its record, or for a single word a base form found by suffix stripping. */
  private async word(text: string, single: boolean): Promise<Found[]> {
    const forms = [...new Set([text, text.replace(/^'+|'+$/gu, '')])].filter(Boolean)
    for (const form of forms) {
      const found = await this.lookup(form)
      if (found.length) return found
    }
    if (!single) return []
    for (const form of forms) {
      for (const candidate of suffixCandidates(normalizeKey(form))) {
        const found = await this.lookup(candidate)
        if (found.length) return found
      }
    }
    return []
  }

  /** The entries under the key of `text`, ranked by spelling, pointers resolved. */
  private async lookup(text: string): Promise<Found[]> {
    const key = normalizeKey(text)
    const record = key ? await this.records.get(key) : undefined
    if (!record) return []
    const rank = (spelling: string) => (spelling === text ? 0 : spelling === spelling.toLowerCase() ? 1 : 2)
    const ordered = record.e.map((entry, i) => ({ entry, i })).sort((a, b) => rank(a.entry.w) - rank(b.entry.w))
    const out: Found[] = []
    for (const { entry, i } of ordered) out.push(...await this.expand(record.k, entry, i, new Set([record.k]), 0))
    return out
  }

  /** An entry as result entries: its pointers' base entries first, then its own meanings. */
  private async expand(key: string, entry: PackEntry, i: number, visited: Set<string>, depth: number): Promise<Found[]> {
    const out: Found[] = []
    for (const pointer of entry.f ?? []) {
      const resolved = await this.resolve(pointer, entry.p, visited, depth + 1)
      if (resolved.length) for (const item of resolved) out.push({ id: item.id, entry: { ...item.entry, note: pointer.n } })
      else if (depth === 0) out.push({ id: `${key}#${i}@${pointer.l}`, entry: { lemma: entry.w, partOfSpeech: entry.p, senses: [{ definition: pointer.n, examples: [] }] } })
    }
    if (entry.s?.length) out.push({ id: `${key}#${i}`, entry: { lemma: entry.w, partOfSpeech: entry.p, senses: entry.s.map(toSense) } })
    return out
  }

  /** The entries a pointer leads to: same spelling and part of speech where there are such. */
  private async resolve(pointer: PackPointer, pos: string, visited: Set<string>, depth: number): Promise<Found[]> {
    const key = normalizeKey(pointer.l)
    if (depth > this.maxPointerDepth || visited.has(key)) return []
    const record = await this.records.get(key)
    if (!record) return []
    let candidates = record.e.map((entry, i) => ({ entry, i }))
    const spelled = candidates.filter(({ entry }) => entry.w === pointer.l)
    if (spelled.length) candidates = spelled
    const samePos = candidates.filter(({ entry }) => entry.p === pos)
    if (samePos.length) candidates = samePos
    const seen = new Set(visited).add(key)
    const out: Found[] = []
    for (const { entry, i } of candidates) out.push(...await this.expand(record.k, entry, i, seen, depth))
    return out
  }
}

/** Opens a pack and returns the dictionary over it. */
export async function openWiktionaryDictionary(source: ByteSource, options: PackReaderOptions & WiktionaryDictionaryOptions = {}): Promise<WiktionaryDictionary> {
  return new WiktionaryDictionary(await PackReader.open(source, options), options)
}
