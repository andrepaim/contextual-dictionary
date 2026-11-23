import { describe, expect, test } from 'vitest'
import { findOccurrence, isFormOf, judgeExample, keptSenses, quotationYear } from '../../../validation/wiktionary-items'

// The evaluation set's helpers (validation/, docs/validation.md): which
// meanings the pack keeps, and where the headword is in an example.
describe('the Wiktionary evaluation set', () => {
  test('meanings are numbered as the pack keeps them: inflection senses and empty glosses do not count', () => {
    const senses = keptSenses([
      { glosses: ['plural of mouse'], form_of: [{ word: 'mouse' }] },
      { glosses: ['A small rodent.'], examples: [{ text: 'a mouse ran' }] },
      { glosses: [] },
      { raw_glosses: ['(computing) An input device.'], glosses: ['An input device.'] },
    ])
    expect(senses.map(sense => [sense.definition, sense.kaikkiIndex])).toEqual([['A small rodent.', 1], ['(computing) An input device.', 3]])
    expect(senses[0]!.examples).toHaveLength(1)
    expect(keptSenses(undefined)).toEqual([])
  })

  test('a quotation year is read from the start of its reference', () => {
    expect(quotationYear('2013 June 1, “End of the peer show”, in The Economist')).toBe(2013)
    expect(quotationYear('c. 1600, William Shakespeare, Hamlet')).toBe(1600)
    expect(quotationYear('Anonymous, undated')).toBeUndefined()
    expect(quotationYear(undefined)).toBeUndefined()
  })

  test('inflected forms count as the word', () => {
    expect(isFormOf('Banks', 'bank', new Set())).toBe(true)
    expect(isFormOf('mice', 'mouse', new Set(['mice']))).toBe(true)
    expect(isFormOf('banking', 'bank', new Set())).toBe(true)
    expect(isFormOf('bandit', 'bank', new Set())).toBe(false)
  })

  test('the editors’ bold span is used, counted in code points, and must be the word alone', () => {
    const text = '😀 Banks and credit-card firms are kept out of the picture.'
    expect(findOccurrence({ text, bold_text_offsets: [[2, 7]] }, 'bank', new Set())).toEqual({ start: 3, end: 8 })
    expect(findOccurrence({ text, bold_text_offsets: [[2, 16]] }, 'bank', new Set())).toBeUndefined()
    expect(findOccurrence({ text: 'The bank-holiday crowd left the bank early.' }, 'bank', new Set())).toEqual({ start: 32, end: 36 })
    expect(findOccurrence({ text: 42 }, 'bank', new Set())).toBeUndefined()
  })

  test('examples that are archaic, short or without the word are left out', () => {
    expect(judgeExample({ text: 'Let it be no bank or common stock, but every man be master.', ref: '1625, Francis Bacon', type: 'quotation' }, 'bank', new Set())).toEqual({ ok: false, reason: 'archaic' })
    expect(judgeExample({ text: 'a bank', type: 'example' }, 'bank', new Set())).toEqual({ ok: false, reason: 'short' })
    expect(judgeExample({ text: 'We walked along the river until the path turned.', type: 'example' }, 'bank', new Set())).toEqual({ ok: false, reason: 'no-occurrence' })
    expect(judgeExample({ text: ' ' }, 'bank', new Set())).toEqual({ ok: false, reason: 'no-text' })
    expect(judgeExample({ text: 'She deposited the cheque at the bank on Monday.', ref: '2001, A Paper', type: 'quotation' }, 'bank', new Set())).toEqual({ ok: true, start: 32, end: 36, year: 2001 })
  })
})
