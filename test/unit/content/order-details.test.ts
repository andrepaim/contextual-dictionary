import { describe, expect, test } from 'vitest'
import { ORDER_STATUS_TEXT, ordinal, orderStatusText, usableDetails } from '../../../src/content/order-details'
import { ORDER_STATUSES, type DictionaryResult } from '../../../src/shared/contracts'

const SOURCE = { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/mouse' }
const senses = (count: number) => Array.from({ length: count }, (_, i) => ({ definition: `meaning ${i}`, examples: [] }))
const result: DictionaryResult = {
  query: 'mouse', source: SOURCE,
  entries: [{ lemma: 'mouse', partOfSpeech: 'noun', senses: senses(3) }, { lemma: 'mouse', partOfSpeech: 'verb', senses: senses(2) }],
}

describe('ordinal', () => {
  test('English ordinals', () => {
    const cases: Array<[number, string]> = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [10, '10th'], [11, '11th'], [12, '12th'], [13, '13th'],
      [21, '21st'], [22, '22nd'], [23, '23rd'], [101, '101st'], [102, '102nd'], [111, '111th'], [112, '112th'], [113, '113th'], [127, '127th']]
    for (const [n, text] of cases) expect(ordinal(n), String(n)).toBe(text)
  })
})

describe('orderStatusText', () => {
  test('the text of every status, as in the plan', () => {
    expect(ORDER_STATUS_TEXT).toEqual({
      'ordered': 'Ordered by context',
      'off': 'Dictionary order · ordering is off',
      'no-model': 'Dictionary order · context model not installed',
      'loading': 'Dictionary order · model still loading',
      'timed-out': 'Dictionary order · model took too long, try again',
      'nothing-to-order': 'Dictionary order · nothing to reorder',
      'not-english': 'Dictionary order · text does not look English',
      'none-fits': 'Dictionary order · the model found no fitting meaning',
      'unavailable': 'Dictionary order · ordering unavailable',
    })
    expect(Object.keys(ORDER_STATUS_TEXT).sort()).toEqual([...ORDER_STATUSES].sort())
  })

  test('an order that moved nothing says it is the dictionary order', () => {
    expect(orderStatusText({ status: 'ordered', positions: [[1, 0, 2], [0, 1]], offered: [3, 2] })).toBe('Ordered by context')
    expect(orderStatusText({ status: 'ordered', positions: [[0, 1, 2], [0, 1]], offered: [3, 2] })).toBe('Ordered by context · same as dictionary order')
    expect(orderStatusText({ status: 'timed-out' })).toBe('Dictionary order · model took too long, try again')
  })

  test('no status text holds a number, a percentage or a time', () => {
    for (const text of Object.values(ORDER_STATUS_TEXT)) expect(text).not.toMatch(/[\d%]|\bms\b|seconds?/)
  })
})

describe('usableDetails', () => {
  const ordered = { status: 'ordered', positions: [[2, 0, 1], [0, 1]], offered: [3, 2] }

  test('well-formed details are kept; positions and counts are only read with "ordered"', () => {
    expect(usableDetails(result, ordered)).toEqual(ordered)
    expect(usableDetails(result, { status: 'ordered', positions: [[0, 1, 2], [1, 0]], offered: [0, 2] })).toEqual({ status: 'ordered', positions: [[0, 1, 2], [1, 0]], offered: [0, 2] })
    for (const status of ORDER_STATUSES.filter(status => status !== 'ordered')) {
      expect(usableDetails(result, { status }), status).toEqual({ status })
      expect(usableDetails(result, { status, positions: [[5]], offered: [9] }), status).toEqual({ status })
    }
  })

  test('details that do not match the result are none', () => {
    const broken: unknown[] = [
      undefined, null, 'ordered', 7, [], {}, { status: 'great' }, { status: 7 },
      { status: 'ordered' },
      { ...ordered, positions: undefined },
      { ...ordered, offered: undefined },
      { ...ordered, positions: [[2, 0, 1]] },
      { ...ordered, positions: [[2, 0, 1], [0, 1], [0]] },
      { ...ordered, positions: [[2, 0], [0, 1]] },
      { ...ordered, positions: [[2, 0, 0], [0, 1]] },
      { ...ordered, positions: [[3, 0, 1], [0, 1]] },
      { ...ordered, positions: [[-1, 0, 1], [0, 1]] },
      { ...ordered, positions: [[1.5, 0, 1], [0, 1]] },
      { ...ordered, positions: [['2', 0, 1], [0, 1]] },
      { ...ordered, positions: [null, [0, 1]] },
      { ...ordered, positions: 'all' },
      { ...ordered, offered: [3] },
      { ...ordered, offered: [4, 2] },
      { ...ordered, offered: [-1, 2] },
      { ...ordered, offered: [1.5, 2] },
      { ...ordered, offered: ['3', 2] },
      { ...ordered, offered: 5 },
    ]
    for (const details of broken) expect(usableDetails(result, details), JSON.stringify(details)).toBeUndefined()
  })
})
