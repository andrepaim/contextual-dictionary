import { describe, expect, test } from 'vitest'
import { codePointSpan, contextualOrder, looksEnglish, senseRequest, type SenseRequest } from '@andrepaim/contextual-dictionary-core'
import type { DictionaryEntry, DictionaryResult, SenseFormat } from '../../../src/shared/contracts'

// The checkpoint's prompt format, with letters that cannot be mistaken for prompt text.
const format: SenseFormat = {
  letters: Array.from({ length: 128 }, (_, i) => String.fromCharCode(0x400 + i)),
  nota_index: 127, none_text: 'none of the above', separator: '[unused0]', mask_token: '[MASK]', max_length: 2048, temperature: 1,
}
const L = (i: number) => format.letters[i]!
const source = { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/bank' }

const bank: DictionaryResult = {
  query: 'bank', source,
  entries: [
    { lemma: 'bank', partOfSpeech: 'noun', senses: [
      { definition: 'sloping land beside a body of water', examples: ['they pulled the canoe up on the bank'] },
      { definition: 'a financial institution that accepts deposits', examples: ['he cashed a check at the bank', 'that bank holds the mortgage'] },
      { definition: 'a long ridge or pile', examples: [] },
    ] },
    { lemma: 'bank', partOfSpeech: 'verb', senses: [
      { definition: 'tip laterally', examples: ['the pilot had to bank the aircraft'] },
      { definition: 'do business with a bank', examples: [] },
    ] },
    { lemma: 'banker', partOfSpeech: 'noun', senses: [{ definition: 'someone who works at a bank', examples: [] }] },
  ],
}
const deposit = { before: 'After the meeting, he walked over and deposited the money at the ', text: 'bank', after: ' before it closed for the day.' }
const request = (result = bank, selection = deposit, maxCandidates?: number): SenseRequest => {
  const built = senseRequest(result, selection, format, maxCandidates)
  if (!('prompt' in built)) throw new Error(`expected a request, got ${JSON.stringify(built)}`)
  return built
}
/** Logits in candidate order, with the "none of the above" logit last. */
function logits(values: number[], none = -10): Float32Array {
  const all = new Float32Array(128).fill(-50)
  values.forEach((value, i) => { all[i] = value })
  all[127] = none
  return all
}
const entry = (partOfSpeech: string, count: number, name = partOfSpeech): DictionaryEntry =>
  ({ lemma: 'run', partOfSpeech, senses: Array.from({ length: count }, (_, i) => ({ definition: `${name} meaning ${i}`, examples: [] })) })
const run = (...entries: DictionaryEntry[]): DictionaryResult => ({ query: 'run', source, entries })
/** How many candidates each entry got, in entry order. */
const perEntry = (built: SenseRequest, entries: number) => Array.from({ length: entries }, (_, e) => built.candidates.filter(c => c.entry === e).length)
/** The meaning lines of the prompt, without "none of the above". */
const choices = (built: SenseRequest) => built.prompt.split('\n').slice(1, -2)

describe('codePointSpan', () => {
  test('JavaScript UTF-16 selection offsets become Unicode code point offsets', () => {
    expect(codePointSpan('😀 bank bank', 8, 12)).toEqual({ start: 7, end: 11, text: 'bank' })
    expect(codePointSpan('plain bank', 6, 10)).toEqual({ start: 6, end: 10, text: 'bank' })
    expect(codePointSpan('😀bank', 1, 3), 'a span that splits a surrogate pair is rejected').toBeNull()
    expect(codePointSpan('bank', 2, 2)).toBeNull()
    expect(codePointSpan('bank', 0, 5)).toBeNull()
    expect(codePointSpan('bank', -1, 2)).toBeNull()
    expect(codePointSpan('bank', 0.5, 2)).toBeNull()
  })
})

describe('senseRequest', () => {
  test('one prompt scores every original candidate on the exact selected span', () => {
    const built = request()
    expect(built.prompt).toBe([
      'After the meeting, he walked over and deposited the money at the *bank* before it closed for the day.',
      `${L(0)}. sloping land beside a body of water`,
      `${L(1)}. a financial institution that accepts deposits`,
      `${L(2)}. a long ridge or pile`,
      `${L(3)}. tip laterally`,
      `${L(4)}. do business with a bank`,
      `${L(5)}. someone who works at a bank`,
      `${L(127)}. none of the above`,
      '[unused0] [MASK]',
    ].join('\n'))
    expect(built.candidates).toEqual([[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [2, 0]].map(([entry, sense]) => ({ entry, sense })))
    expect(built.target).toEqual({ start: 65, end: 69, text: 'bank' })
    expect(built.total).toBe(6)
  })

  test('the target counts code points after an emoji and keeps the selection exact, not its completion', () => {
    const built = request(bank, { before: '😀 The money is in the ', text: 'bank ', after: 'vault, and it is safe there.' })
    expect(built.target).toEqual({ start: 22, end: 26, text: 'bank' })
    expect(built.prompt).toMatch(/^😀 The money is in the \*bank\* vault, and it is safe there\.\n/)
    // Half of a hyphenated word is marked as selected; the dictionary completes it separately.
    const half = request(bank, { before: 'The data was stored in a river-', text: 'bank', after: ' for the analysis of the region.' })
    expect(half.prompt).toMatch(/river-\*bank\* for/)
  })

  test('line breaks and runs of spaces in the page text become single spaces', () => {
    const built = request(bank, { before: 'He paid the money\n into the  ', text: 'bank', after: '\tand the account that was there.' })
    expect(built.prompt).toMatch(/^He paid the money into the \*bank\* and the account that was there\.\n/)
  })

  test('unsupported inputs are not scored', () => {
    const single: DictionaryResult = { ...bank, entries: [bank.entries[2]!, { ...bank.entries[0]!, senses: bank.entries[0]!.senses.slice(0, 1) }] }
    expect(senseRequest(single, deposit, format)).toEqual({ skip: 'SINGLE_SENSES' })
    expect(senseRequest({ ...bank, entries: [] }, deposit, format)).toEqual({ skip: 'NO_ENTRIES' })
    expect(senseRequest(bank, { ...deposit, after: ' before it closed*.' }, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    expect(senseRequest(bank, { ...deposit, before: 'He saw [MASK] and the money at the ' }, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    expect(senseRequest(bank, { ...deposit, before: 'He saw [SEP] and the money at the ' }, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    expect(senseRequest(bank, { ...deposit, before: 'He saw \u0007 and the money at the ' }, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    const starred: DictionaryResult = { ...bank, entries: [{ ...bank.entries[0]!, senses: [...bank.entries[0]!.senses, { definition: 'a *special* bank', examples: [] }] }] }
    expect(senseRequest(starred, deposit, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    const separator: DictionaryResult = { ...bank, entries: [{ ...bank.entries[0]!, senses: [...bank.entries[0]!.senses, { definition: 'a bank [unused0] here', examples: [] }] }] }
    expect(senseRequest(separator, deposit, format)).toEqual({ skip: 'UNSAFE_TEXT' })
    expect(senseRequest(bank, { before: 'Ele depositou o dinheiro no ', text: 'bank', after: ' antes de fechar para o dia.' }, format)).toEqual({ skip: 'NOT_ENGLISH' })
    expect(senseRequest(bank, { ...deposit, text: '   ' }, format)).toEqual({ skip: 'INVALID_SPAN' })
    expect(senseRequest(bank, { ...deposit, before: 'the money at the \uDC00' }, format)).toEqual({ skip: 'INVALID_SPAN' })
  })

  test('a lone surrogate cut off at the edge of the context is dropped, not sent', () => {
    const built = request(bank, { before: '\uDE00 he deposited the money at the ', text: 'bank', after: ' and then he left \uD83D' })
    expect(built.prompt).toMatch(/^he deposited the money at the \*bank\* and then he left\n/)
  })

  test('a format whose letters do not reach "none of the above" is refused', () => {
    expect(senseRequest(bank, deposit, { ...format, letters: format.letters.slice(0, 127) })).toEqual({ skip: 'INVALID_FORMAT' })
    expect(senseRequest(bank, deposit, { ...format, nota_index: 1 })).toEqual({ skip: 'INVALID_FORMAT' })
  })
})

describe('the candidate cap', () => {
  test('more meanings than the model takes are capped, not skipped (pdfpal returned TOO_MANY_SENSES)', () => {
    const many = run(entry('verb', 128))
    const built = request(many, deposit)
    expect(built.candidates).toHaveLength(127)
    expect(built.total).toBe(128)
    expect(built.candidates.at(-1)).toEqual({ entry: 0, sense: 126 })
    expect(choices(built)).toHaveLength(127)
    expect(choices(built).at(-1)).toBe(`${L(126)}. verb meaning 126`)
    expect(built.prompt.split('\n').at(-2)).toBe(`${L(127)}. none of the above`)
  })

  test('under the cap every meaning is offered', () => {
    const built = request(run(entry('noun', 10), entry('verb', 10)), deposit, 20)
    expect(built.candidates).toHaveLength(20)
    expect(built.total).toBe(20)
  })

  test('the cap is shared round-robin by entry in dictionary order, so a large first entry cannot starve the others', () => {
    const result = run(entry('noun', 100), entry('verb', 10), entry('adj', 1))
    const built = request(result, deposit, 20)
    // Round 0 takes the first meaning of each entry, every later round the next one of each entry that still has one.
    expect(perEntry(built, 3)).toEqual([10, 9, 1])
    expect(built.total).toBe(111)
    // Each entry contributes its first meanings, in dictionary order.
    for (const e of [0, 1, 2]) {
      const senses = built.candidates.filter(c => c.entry === e).map(c => c.sense)
      expect(senses).toEqual(senses.map((_, i) => i))
    }
    // Room an exhausted entry leaves goes to the entries that still have meanings.
    expect(perEntry(request(result, deposit, 48), 3)).toEqual([37, 10, 1])
  })

  test('the prompt lists the offered meanings in dictionary order with consecutive letters', () => {
    const built = request(run(entry('noun', 5), entry('verb', 5)), deposit, 4)
    expect(built.candidates).toEqual([{ entry: 0, sense: 0 }, { entry: 0, sense: 1 }, { entry: 1, sense: 0 }, { entry: 1, sense: 1 }])
    expect(choices(built)).toEqual([`${L(0)}. noun meaning 0`, `${L(1)}. noun meaning 1`, `${L(2)}. verb meaning 0`, `${L(3)}. verb meaning 1`])
  })

  test('a cap above the model limit is lowered to it, and an unusable cap is read as the model limit or the smallest useful one', () => {
    const many = run(entry('verb', 200))
    expect(request(many, deposit, 500).candidates).toHaveLength(127)
    expect(request(many, deposit, Number.NaN).candidates).toHaveLength(127)
    expect(request(many, deposit, 1).candidates).toHaveLength(2)
    expect(request(many, deposit, 7.9).candidates).toHaveLength(7)
    expect(request(run(entry('verb', 10)), deposit, 4.5).candidates).toHaveLength(4)
  })

  test('a cap too small to give any entry two meanings is skipped', () => {
    const three = run(entry('noun', 3), entry('verb', 3), entry('adj', 3))
    expect(senseRequest(three, deposit, format, 2)).toEqual({ skip: 'TOO_MANY_SENSES' })
    expect(perEntry(request(three, deposit, 4), 3)).toEqual([2, 1, 1])
  })

  test('only offered definitions are checked for unsafe text', () => {
    const result = run({ ...entry('noun', 4), senses: [...entry('noun', 4).senses, { definition: 'a *starred* meaning', examples: [] }] })
    expect(request(result, deposit, 4).candidates).toHaveLength(4)
    expect(senseRequest(result, deposit, format, 5)).toEqual({ skip: 'UNSAFE_TEXT' })
  })

  test('a prompt over the length bound offers fewer meanings instead of being skipped', () => {
    const long = (name: string, count: number): DictionaryEntry =>
      ({ lemma: 'set', partOfSpeech: name, senses: Array.from({ length: count }, (_, i) => ({ definition: `${name} ${i} ${'x'.repeat(1000)}`, examples: [] })) })
    const result: DictionaryResult = { query: 'set', source, entries: [long('noun', 20), long('verb', 20)] }
    const built = request(result, deposit, 48)
    expect(built.prompt.length).toBeLessThanOrEqual(format.max_length * 8)
    expect(built.candidates.length).toBeLessThan(40)
    expect(built.candidates.length).toBeGreaterThan(10)
    expect(built.total).toBe(40)
    // Meanings are dropped from the end of the round-robin order, so the entries stay balanced.
    const [noun, verb] = perEntry(built, 2)
    expect(Math.abs(noun! - verb!)).toBeLessThanOrEqual(1)
    // One more meaning would not have fitted.
    expect(request(result, deposit, built.candidates.length + 1).candidates).toHaveLength(built.candidates.length)
  })

  test('a limit on the prompt length offers the first meanings of the round-robin order that fit, and never more than the cap', () => {
    const entry = (name: string, count: number): DictionaryEntry =>
      ({ lemma: 'set', partOfSpeech: name, senses: Array.from({ length: count }, (_, i) => ({ definition: `${name} meaning number ${i} ${'x'.repeat(40)}`, examples: [] })) })
    const result: DictionaryResult = { query: 'set', source, entries: [entry('noun', 20), entry('verb', 20)] }
    const limited = senseRequest(result, deposit, format, 48, 900)
    if (!('prompt' in limited)) throw new Error('expected a prompt')
    expect(limited.prompt.length).toBeLessThanOrEqual(900)
    expect(limited.candidates.length).toBeGreaterThanOrEqual(2)
    expect(limited.candidates.length).toBeLessThan(20)
    const [noun, verb] = perEntry(limited, 2)
    expect(Math.abs(noun! - verb!)).toBeLessThanOrEqual(1)
    // One more meaning would not have fitted.
    const more = senseRequest(result, deposit, format, limited.candidates.length + 1, 100_000)
    if (!('prompt' in more)) throw new Error('expected a prompt')
    expect(more.prompt.length).toBeGreaterThan(900)
    // The cap still applies under a generous limit, and no limit is the model's own bound.
    expect(request(result, deposit, 6).candidates).toHaveLength(6)
    const capped = senseRequest(result, deposit, format, 6, 100_000)
    expect('prompt' in capped && capped.candidates).toHaveLength(6)
    expect(senseRequest(result, deposit, format, 48, Number.NaN)).toEqual(senseRequest(result, deposit, format, 48))
    expect(senseRequest(result, deposit, format, 48, 50)).toEqual({ skip: 'TOO_LONG' })
  })

  test('a passage or definitions too long for even two meanings are skipped', () => {
    const huge: DictionaryResult = { ...bank, entries: [{ ...bank.entries[0]!, senses: [{ definition: 'x'.repeat(9000), examples: [] }, { definition: 'y'.repeat(9000), examples: [] }] }] }
    expect(senseRequest(huge, deposit, format)).toEqual({ skip: 'TOO_LONG' })
    expect(senseRequest(bank, deposit, { ...format, max_length: 10 })).toEqual({ skip: 'TOO_LONG' })
  })
})

describe('contextualOrder', () => {
  test('senses are sorted by score only inside each entry, stably, keeping every definition and example', () => {
    const built = request()
    const ordered = contextualOrder(bank, built, logits([1, 5, 1, -2, 3, 0]), format)
    expect(ordered.applied).toBe(true)
    expect(ordered.result.entries.map(entry => [entry.lemma, entry.partOfSpeech])).toEqual([['bank', 'noun'], ['bank', 'verb'], ['banker', 'noun']])
    expect(ordered.result.entries[0]!.senses).toEqual([bank.entries[0]!.senses[1], bank.entries[0]!.senses[0], bank.entries[0]!.senses[2]])
    expect(ordered.result.entries[1]!.senses).toEqual([bank.entries[1]!.senses[1], bank.entries[1]!.senses[0]])
    expect(ordered.result.entries[2]).toEqual(bank.entries[2])
    expect(Object.keys(ordered.result)).toEqual(Object.keys(bank))
    expect(ordered.result.query).toBe(bank.query)
    expect(ordered.result.source).toEqual(bank.source)
    // The original result is not modified.
    expect(bank.entries[0]!.senses[0]!.definition).toBe('sloping land beside a body of water')
  })

  test('an entry note is kept', () => {
    const noted: DictionaryResult = { ...bank, entries: [{ ...bank.entries[0]!, note: 'plural of bank' }] }
    const ordered = contextualOrder(noted, request(noted), logits([1, 5, 1]), format)
    expect(ordered.applied).toBe(true)
    expect(ordered.result.entries[0]!.note).toBe('plural of bank')
  })

  test('equal scores keep dictionary order', () => {
    const ordered = contextualOrder(bank, request(), logits([2, 2, 2, 1, 1, 0]), format)
    expect(ordered.result).toEqual(bank)
  })

  test('dictionary order is kept, as the very same object, when "none of the above" wins or ties, or the scores are unusable', () => {
    const built = request()
    for (const [scores, reason] of [
      [logits([1, 5, 1, -2, 3, 0], 6), 'NONE_FITS'],
      [logits([1, 5, 1, -2, 3, 0], 5), 'NONE_FITS'],
      [logits([1, Number.NaN, 1, -2, 3, 0]), 'INVALID_SCORES'],
      [new Float32Array(12), 'INVALID_SCORES'],
    ] as const) {
      const outcome = contextualOrder(bank, built, scores, format)
      expect(outcome).toEqual({ result: bank, applied: false, reason })
      expect(outcome.result).toBe(bank)
    }
    expect(contextualOrder(bank, { ...built, candidates: [] }, logits([1]), format).result).toBe(bank)
  })

  test('a temperature divides the logits before the softmax', () => {
    // "None" at 6 still beats 5 after dividing by 10; a temperature of 0 is read as 1.
    const built = request()
    expect(contextualOrder(bank, built, logits([1, 5, 1, -2, 3, 0], 6), { ...format, temperature: 10 }).applied).toBe(false)
    expect(contextualOrder(bank, built, logits([1, 5, 1, -2, 3, 0]), { ...format, temperature: 0 }).applied).toBe(true)
  })

  test('unscored meanings keep their relative order after the scored ones of the same entry', () => {
    const result = run(entry('noun', 6), entry('verb', 3))
    const built = request(result, deposit, 4)
    expect(built.candidates).toEqual([{ entry: 0, sense: 0 }, { entry: 0, sense: 1 }, { entry: 1, sense: 0 }, { entry: 1, sense: 1 }])
    const ordered = contextualOrder(result, built, logits([-3, 4, -1, 2]), format)
    expect(ordered.applied).toBe(true)
    const names = (e: number) => ordered.result.entries[e]!.senses.map(sense => sense.definition)
    expect(names(0)).toEqual(['noun meaning 1', 'noun meaning 0', 'noun meaning 2', 'noun meaning 3', 'noun meaning 4', 'noun meaning 5'])
    expect(names(1)).toEqual(['verb meaning 1', 'verb meaning 0', 'verb meaning 2'])
  })

  test('a scored meaning whose probability underflows to zero still comes before the unscored ones', () => {
    const result = run(entry('noun', 4))
    const built = { ...request(result, deposit, 2), candidates: [{ entry: 0, sense: 2 }, { entry: 0, sense: 3 }] }
    const ordered = contextualOrder(result, built, logits([50, -2000], -2000), format)
    expect(ordered.result.entries[0]!.senses.map(sense => sense.definition)).toEqual(['noun meaning 2', 'noun meaning 3', 'noun meaning 0', 'noun meaning 1'])
  })

  test('an entry with no scored meaning keeps dictionary order', () => {
    const result = run(entry('noun', 3), entry('verb', 3), entry('adj', 3))
    const built = request(result, deposit, 4)
    const capped = { ...built, candidates: built.candidates.filter(c => c.entry !== 2) }
    const ordered = contextualOrder(result, capped, logits([0, 3, 0]), format)
    expect(ordered.result.entries[2]).toEqual(result.entries[2])
    expect(ordered.result.entries[0]!.senses[0]!.definition).toBe('noun meaning 1')
  })
})

describe('contextualOrder: positions and offered counts (order details)', () => {
  /** The applied outcome's details; fails the test when the order was not applied. */
  const details = (outcome: ReturnType<typeof contextualOrder>) => {
    if (!outcome.applied) throw new Error(`expected an applied order, got ${outcome.reason}`)
    return { positions: outcome.positions, offered: outcome.offered }
  }

  test('each meaning carries its dictionary position, and each entry the number of meanings offered', () => {
    const outcome = contextualOrder(bank, request(), logits([1, 5, 1, -2, 3, 0]), format)
    expect(details(outcome)).toEqual({ positions: [[1, 0, 2], [1, 0], [0]], offered: [3, 2, 1] })
    // The positions describe the answer: senses[i] is the dictionary's senses[positions[i]].
    outcome.result.entries.forEach((entry, e) => entry.senses.forEach((sense, i) => expect(sense).toBe(bank.entries[e]!.senses[details(outcome).positions[e]![i]!])))
  })

  test('ties keep dictionary order, so the positions are the identity', () => {
    expect(details(contextualOrder(bank, request(), logits([2, 2, 2, 1, 1, 0]), format))).toEqual({ positions: [[0, 1, 2], [0, 1], [0]], offered: [3, 2, 1] })
  })

  test('meanings not offered follow in dictionary order, after the offered ones', () => {
    const result = run(entry('noun', 6), entry('verb', 3))
    const outcome = contextualOrder(result, request(result, deposit, 4), logits([-3, 4, -1, 2]), format)
    expect(details(outcome)).toEqual({ positions: [[1, 0, 2, 3, 4, 5], [1, 0, 2]], offered: [2, 2] })
  })

  test('an entry offered nothing counts 0 and keeps its order', () => {
    const result = run(entry('noun', 3), entry('verb', 3), entry('adj', 3))
    const built = request(result, deposit, 4)
    const capped = { ...built, candidates: built.candidates.filter(c => c.entry !== 2) }
    expect(details(contextualOrder(result, capped, logits([0, 3, 0]), format))).toEqual({ positions: [[1, 0, 2], [0, 1, 2], [0, 1, 2]], offered: [2, 1, 0] })
  })

  test('offered meanings that are not the first ones still come first', () => {
    const result = run(entry('noun', 4))
    const built = { ...request(result, deposit, 2), candidates: [{ entry: 0, sense: 2 }, { entry: 0, sense: 3 }] }
    expect(details(contextualOrder(result, built, logits([50, -2000], -2000), format))).toEqual({ positions: [[2, 3, 0, 1]], offered: [2] })
  })

  test('an order that is not applied carries no positions', () => {
    const outcome = contextualOrder(bank, request(), logits([1, 5, 1, -2, 3, 0], 6), format)
    expect(outcome).toEqual({ result: bank, applied: false, reason: 'NONE_FITS' })
  })

  test('by default every entry keeps its place, so the entry positions are the identity', () => {
    const outcome = contextualOrder(bank, request(), logits([1, 5, 1, -2, 3, 0]), format)
    if (!outcome.applied) throw new Error(outcome.reason)
    expect(outcome.entryPositions).toEqual([0, 1, 2])
  })
})

describe('contextualOrder: the best entry first (option)', () => {
  // Four entries of two meanings each: every meaning is offered, in dictionary order.
  const four = run(entry('noun', 2), entry('verb', 2), entry('adj', 2), entry('adv', 2))
  /** Probabilities in candidate order; "none of the above" gets almost nothing. */
  const probabilities = (values: number[]) => logits(values.map(Math.log), -50)
  const applied = (outcome: ReturnType<typeof contextualOrder>) => {
    if (!outcome.applied) throw new Error(`expected an applied order, got ${outcome.reason}`)
    return outcome
  }
  const heads = (outcome: ReturnType<typeof contextualOrder>) => outcome.result.entries.map(item => item.partOfSpeech)
  // The best meaning, adj meaning 1 (0.4), beats the first entry's best (noun meaning 0, 0.2) by 0.2.
  const adjBest = probabilities([0.2, 0.1, 0.05, 0.05, 0.1, 0.4, 0.05, 0.05])

  test('without the option the entries keep dictionary order, whatever the scores', () => {
    const outcome = applied(contextualOrder(four, request(four), adjBest, format))
    expect(heads(outcome)).toEqual(['noun', 'verb', 'adj', 'adv'])
    expect(outcome.entryPositions).toEqual([0, 1, 2, 3])
    expect(applied(contextualOrder(four, request(four), adjBest, format, {})).entryPositions).toEqual([0, 1, 2, 3])
    expect(applied(contextualOrder(four, request(four), adjBest, format, { bestEntryFirst: false, entryMargin: 0 })).entryPositions).toEqual([0, 1, 2, 3])
  })

  test('the entry holding the best meaning moves first; the others keep dictionary order among themselves', () => {
    const outcome = applied(contextualOrder(four, request(four), adjBest, format, { bestEntryFirst: true }))
    expect(heads(outcome)).toEqual(['adj', 'noun', 'verb', 'adv'])
    expect(outcome.entryPositions).toEqual([2, 0, 1, 3])
    // Inside each entry the meanings are still ordered by the model.
    expect(outcome.result.entries[0]!.senses.map(sense => sense.definition)).toEqual(['adj meaning 1', 'adj meaning 0'])
    // The meaning positions and offered counts follow their entries.
    expect(outcome.positions).toEqual([[1, 0], [0, 1], [0, 1], [0, 1]])
    expect(outcome.offered).toEqual([2, 2, 2, 2])
    outcome.result.entries.forEach((item, place) => expect(item).toEqual({ ...four.entries[outcome.entryPositions[place]!]!, senses: item.senses }))
    expect(outcome.result.query).toBe(four.query)
    expect(outcome.result.source).toEqual(four.source)
    // The original result is not modified.
    expect(four.entries.map(item => item.partOfSpeech)).toEqual(['noun', 'verb', 'adj', 'adv'])
  })

  test('the entry moves only when its best meaning beats the first entry\'s best by at least the margin', () => {
    expect(applied(contextualOrder(four, request(four), adjBest, format, { bestEntryFirst: true, entryMargin: 0.15 })).entryPositions).toEqual([2, 0, 1, 3])
    const below = applied(contextualOrder(four, request(four), adjBest, format, { bestEntryFirst: true, entryMargin: 0.25 }))
    expect(below.entryPositions).toEqual([0, 1, 2, 3])
    expect(heads(below)).toEqual(['noun', 'verb', 'adj', 'adv'])
    // The meanings inside each entry are ordered all the same.
    expect(below.result.entries[2]!.senses.map(sense => sense.definition)).toEqual(['adj meaning 1', 'adj meaning 0'])
  })

  test('a margin that is not a positive number counts as no margin', () => {
    for (const entryMargin of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const expected = entryMargin === Number.POSITIVE_INFINITY ? [0, 1, 2, 3] : [2, 0, 1, 3]
      expect(applied(contextualOrder(four, request(four), adjBest, format, { bestEntryFirst: true, entryMargin })).entryPositions).toEqual(expected)
    }
  })

  test('nothing moves when the first entry holds the best meaning, or the best entries tie', () => {
    const first = probabilities([0.4, 0.1, 0.05, 0.05, 0.1, 0.2, 0.05, 0.05])
    expect(applied(contextualOrder(four, request(four), first, format, { bestEntryFirst: true })).entryPositions).toEqual([0, 1, 2, 3])
    const tie = probabilities([0.3, 0.05, 0.05, 0.05, 0.05, 0.3, 0.1, 0.1])
    expect(applied(contextualOrder(four, request(four), tie, format, { bestEntryFirst: true })).entryPositions).toEqual([0, 1, 2, 3])
    // Of two later entries that tie, the earlier one moves.
    const later = probabilities([0.1, 0.05, 0.3, 0.05, 0.05, 0.3, 0.1, 0.05])
    expect(applied(contextualOrder(four, request(four), later, format, { bestEntryFirst: true })).entryPositions).toEqual([1, 0, 2, 3])
  })

  test('a single entry has nowhere to move', () => {
    const one = run(entry('noun', 3))
    const outcome = applied(contextualOrder(one, request(one), probabilities([0.1, 0.8, 0.1]), format, { bestEntryFirst: true }))
    expect(outcome.entryPositions).toEqual([0])
    expect(outcome.positions).toEqual([[1, 0, 2]])
  })

  test('dictionary order is kept, entries included, when "none of the above" wins or the scores are unusable', () => {
    const built = request(four)
    const none = logits([0.2, 0.1, 0.05, 0.05, 0.1, 0.4, 0.05, 0.05].map(Math.log), Math.log(0.5))
    for (const [scores, reason] of [[none, 'NONE_FITS'], [new Float32Array(12), 'INVALID_SCORES']] as const) {
      const outcome = contextualOrder(four, built, scores, format, { bestEntryFirst: true })
      expect(outcome).toEqual({ result: four, applied: false, reason })
      expect(outcome.result).toBe(four)
    }
  })

  test('an entry offered nothing never moves first, and a first entry offered nothing counts as scoring 0', () => {
    const built = request(four)
    const withoutAdj = { ...built, candidates: built.candidates.filter(c => c.entry !== 2) }
    // noun 0.2, 0.1; verb 0.3, 0.1; adv 0.2, 0.1: the verb entry is best; the adjective entry was not offered.
    const outcome = applied(contextualOrder(four, withoutAdj, probabilities([0.2, 0.1, 0.3, 0.1, 0.2, 0.1]), format, { bestEntryFirst: true }))
    expect(outcome.entryPositions).toEqual([1, 0, 2, 3])
    expect(outcome.offered).toEqual([2, 2, 0, 2])
    const withoutNoun = { ...built, candidates: built.candidates.filter(c => c.entry !== 0) }
    const moved = applied(contextualOrder(four, withoutNoun, probabilities([0.15, 0.05, 0.15, 0.4, 0.15, 0.1]), format, { bestEntryFirst: true, entryMargin: 0.25 }))
    expect(moved.entryPositions).toEqual([2, 0, 1, 3])
    expect(moved.offered).toEqual([2, 0, 2, 2])
  })
})

describe('looksEnglish', () => {
  test('only an English passage is scored', () => {
    expect(looksEnglish('After the meeting, he walked over and deposited the money at the bank before it closed.')).toBe(true)
    expect(looksEnglish('We train the model with gradient descent and evaluate it on held-out data.')).toBe(true)
    expect(looksEnglish('the bank'), 'too short to judge, but in Latin script and without foreign words').toBe(true)
    expect(looksEnglish('Ela depositou dinheiro no banco antes de fechar para o dia.')).toBe(false)
    expect(looksEnglish('El modelo se entrena con los datos de la empresa y es muy bueno.')).toBe(false)
    expect(looksEnglish('Das Modell wird mit den Daten trainiert und ist nicht schlecht.')).toBe(false)
    expect(looksEnglish('Le modèle est entraîné sur les données et il est très bon pour la tâche.')).toBe(false)
    expect(looksEnglish('Модель обучается на данных и работает хорошо в этой задаче.')).toBe(false)
    expect(looksEnglish('模型在数据上训练并且效果很好。')).toBe(false)
    expect(looksEnglish('123 456 789')).toBe(false)
    expect(looksEnglish('der bank')).toBe(false)
  })

  test('short plain English sentences are scored too (stage 3: 5% of Wiktionary examples were refused)', () => {
    expect(looksEnglish('The expense far exceeds what I expected.')).toBe(true)
    expect(looksEnglish('Can you refill my cup please? I have finished my coffee.')).toBe(true)
    expect(looksEnglish('The sidewalk needed sweeping every morning.')).toBe(true)
    expect(looksEnglish('How much do you usually tip at a restaurant?')).toBe(true)
    expect(looksEnglish('Jerk chicken is a local favorite.')).toBe(true)
  })

  test('other languages stay unscored with the longer English word list', () => {
    expect(looksEnglish('I ragazzi giocano a calcio nel parco ogni pomeriggio dopo la scuola.')).toBe(false)
    expect(looksEnglish('Ho comprato i biglietti per il concerto di domani sera con mia sorella.')).toBe(false)
    expect(looksEnglish('Wij hebben gisteren een nieuwe auto gekocht voor de familie.')).toBe(false)
    expect(looksEnglish('Saya membeli mobil baru untuk keluarga kemarin malam.')).toBe(false)
    expect(looksEnglish('Jag har köpt en ny bil till familjen i går kväll.')).toBe(false)
    expect(looksEnglish('Hemos comprado un coche nuevo para toda la familia ayer.')).toBe(false)
    expect(looksEnglish('Eu fui ao mercado comprar pão e leite para o café da manhã.')).toBe(false)
  })
})
