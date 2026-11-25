// Pure helpers of the Simple English Wiktionary evaluation set: which of its
// examples English Wiktionary also has (they are left out, so the set stays
// independent of the English examples), and the meanings a dictionary made
// of Simple English Wiktionary would offer for a spelling. Tested in
// test/unit/validation/simple-items.test.ts.
import { DEFAULT_SCOPE, pickExamples } from '../src/dict/kaikki'
import type { DictionaryEntry, DictionaryResult } from '../src/shared/contracts'
import { keptSenses } from './wiktionary-items'

/** An example as it is compared: lower case, letters and digits only, single spaces. */
export const normalizeExample = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const words = (text: string) => (text ? text.split(' ').length : 0)
const within = (part: string, whole: string) => ` ${whole} `.includes(` ${part} `)

/**
 * Whether an example repeats one of `others` (already normalised): the same
 * text, or one inside the other when the shorter has at least `minWords`
 * words, so a phrase such as "a long run" does not match every sentence
 * that holds it.
 */
export function repeatsExample(example: string, others: ReadonlySet<string>, minWords = 4): boolean {
  const text = normalizeExample(example)
  if (!text) return false
  if (others.has(text)) return true
  const long = words(text) >= minWords
  for (const other of others) {
    if (long && within(text, other)) return true
    if (words(other) >= minWords && within(other, text)) return true
  }
  return false
}

export const SIMPLE_SOURCE = { name: 'Simple English Wiktionary', license: 'CC BY-SA 4.0', url: 'https://simple.wiktionary.org/' }

/**
 * What a card would show for `word` if the dictionary were Simple English
 * Wiktionary: one entry per record of that spelling, in extract order, with
 * the pack's scope (proper names and symbols left out, empty glosses
 * dropped, markup removed, two short examples). `entryOf[i]` is the entry
 * of `records[i]`, or -1 when the record gives none.
 */
export function simpleResult(word: string, records: readonly unknown[]): { result: DictionaryResult; entryOf: number[] } {
  const entries: DictionaryEntry[] = []
  const entryOf = records.map(record => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return -1
    const { word: lemma, pos, senses } = record as { word?: unknown; pos?: unknown; senses?: unknown }
    if (typeof lemma !== 'string' || typeof pos !== 'string' || DEFAULT_SCOPE.excludedPos.includes(pos)) return -1
    const kept = keptSenses(senses)
    if (!kept.length) return -1
    entries.push({ lemma, partOfSpeech: pos, senses: kept.map(sense => ({ definition: sense.definition, examples: pickExamples(sense.examples, DEFAULT_SCOPE) })) })
    return entries.length - 1
  })
  return { result: { query: word, entries, source: SIMPLE_SOURCE }, entryOf }
}
