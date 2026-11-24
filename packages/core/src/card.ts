import type { DictionaryEntry, DictionarySense } from './contracts.js'

const ENTRY_LIMIT = 3
const MEANING_LIMIT = 3
const EXAMPLE_LIMIT = 1

export interface CardPreviewSense { sense: DictionarySense; examples: readonly string[] }
export interface CardPreviewEntry { entry: DictionaryEntry; senses: CardPreviewSense[] }
export interface CardPreview { entries: CardPreviewEntry[]; canExpand: boolean }

/** Select the visible entries, senses and examples in dictionary result order. */
export function cardPreview(entries: readonly DictionaryEntry[], expanded: boolean): CardPreview {
  const canExpand = entries.length > ENTRY_LIMIT || entries.some(entry =>
    entry.senses.length > MEANING_LIMIT || entry.senses.some(sense => sense.examples.length > EXAMPLE_LIMIT),
  )
  const visibleEntries = expanded ? entries : entries.slice(0, ENTRY_LIMIT)
  return {
    entries: visibleEntries.map((entry) => {
      const visibleSenses = expanded ? entry.senses : entry.senses.slice(0, MEANING_LIMIT)
      return {
        entry,
        senses: visibleSenses.map(sense => ({
          sense,
          examples: expanded ? sense.examples : sense.examples.slice(0, EXAMPLE_LIMIT),
        })),
      }
    }),
    canExpand,
  }
}
