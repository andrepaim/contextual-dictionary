import { expect, it } from 'vitest'
import type { DictionaryEntry } from '@andrepaim/contextual-dictionary-core'
import { cardPreview } from '@andrepaim/contextual-dictionary-core/card'
import { cardFixture } from '@andrepaim/contextual-dictionary-core/card-fixture'

it('caps entries, senses and examples in the fixture preview', () => {
  const original = structuredClone(cardFixture)
  const preview = cardPreview(cardFixture.entries, false)
  expect(preview.canExpand).toBe(true)
  expect(preview.entries.map(({ entry }) => entry.partOfSpeech)).toEqual(['noun', 'verb', 'adjective'])
  expect(preview.entries[0]?.senses).toHaveLength(3)
  expect(preview.entries[0]?.senses[0]?.examples).toEqual(['A glintmark shone on the brass plate.'])
  expect(preview.entries[0]?.entry).toBe(cardFixture.entries[0])
  expect(preview.entries[0]?.senses[0]?.sense).toBe(cardFixture.entries[0]?.senses[0])
  expect(cardFixture).toEqual(original)
})

it('restores the complete result in order and keeps the toggle available when expanded', () => {
  const expanded = cardPreview(cardFixture.entries, true)
  expect(expanded.canExpand).toBe(true)
  expect(expanded.entries.map(({ entry }) => entry)).toEqual(cardFixture.entries)
  for (const [index, { entry, senses }] of expanded.entries.entries()) {
    expect(entry).toBe(cardFixture.entries[index])
    expect(senses.map(({ sense }) => sense)).toEqual(entry.senses)
    for (const [position, { sense, examples }] of senses.entries()) {
      expect(sense).toBe(entry.senses[position])
      expect(examples).toEqual(sense.examples)
    }
  }
  expect(expanded.entries[0]?.senses[3]?.sense.definition).toBe('A tally made with reflective ink.')
  expect(expanded.entries[3]?.senses[0]?.sense.definition).toBe('With a brief flash.')
})

it('offers expansion when only examples are hidden', () => {
  const [entry] = cardFixture.entries
  const [sense] = entry!.senses
  const entries = [{ ...entry!, senses: [sense!] }]
  expect(cardPreview(entries, false).canExpand).toBe(true)
  expect(cardPreview(entries, true).entries[0]?.senses[0]?.examples).toEqual([
    'A glintmark shone on the brass plate.',
    'The jeweller buffed away the glintmark.',
  ])
})

it('offers expansion when only entries or only senses are hidden', () => {
  const entry: DictionaryEntry = { lemma: 'sole', partOfSpeech: 'noun', senses: [{ definition: 'The bottom of a foot.', examples: [] }] }
  expect(cardPreview([entry, entry, entry, entry], false).canExpand).toBe(true)
  expect(cardPreview([{ ...entry, senses: Array(4).fill(entry.senses[0]) }], false).canExpand).toBe(true)
})

it('fits empty results and results at each preview limit without expansion', () => {
  const entry: DictionaryEntry = {
    lemma: 'sole', partOfSpeech: 'noun',
    senses: [
      { definition: 'The bottom of a foot.', examples: ['The sole of my foot was sore.'] },
      { definition: 'The bottom of a shoe.', examples: [] },
      { definition: 'A type of fish.', examples: [] },
    ],
  }
  expect(cardPreview([], false)).toEqual({ entries: [], canExpand: false })
  const preview = cardPreview([entry, entry, entry], false)
  expect(preview.canExpand).toBe(false)
  expect(preview.entries).toHaveLength(3)
  expect(preview.entries[0]?.senses.map(({ examples }) => examples)).toEqual([['The sole of my foot was sore.'], [], []])
  expect(cardPreview([entry], true).canExpand).toBe(false)
})
