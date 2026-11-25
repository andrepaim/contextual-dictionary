import { describe, expect, test } from 'vitest'
import { normalizeExample, repeatsExample, simpleResult } from '../../../validation/simple-items'

// The Simple English Wiktionary evaluation set's helpers (validation/,
// docs/validation.md): which examples English Wiktionary also has, and the
// meanings offered for a headword.
describe('the Simple English Wiktionary evaluation set', () => {
  test('examples are compared without case, punctuation or spacing', () => {
    expect(normalizeExample('  “I’m going for a run.”  ')).toBe('i m going for a run')
    expect(normalizeExample('Él corrió — rápido!')).toBe('él corrió rápido')
    expect(normalizeExample('…')).toBe('')
  })

  test('an example English Wiktionary also has is a repeat, whole or as part of a longer one', () => {
    const english = new Set(['the sponge absorbed the spilled water', 'he ran from the cops and hid in the old barn', 'a long run'])
    expect(repeatsExample('The sponge absorbed the spilled water.', english)).toBe(true)
    expect(repeatsExample('He ran from the cops.', english)).toBe(true)
    expect(repeatsExample('Yesterday the sponge absorbed the spilled water again.', english)).toBe(true)
    expect(repeatsExample('The car runs well.', english)).toBe(false)
  })

  test('a short English phrase inside a longer sentence is not a repeat', () => {
    expect(repeatsExample('The musical had a long run on Broadway.', new Set(['a long run']))).toBe(false)
    expect(repeatsExample('A long run.', new Set(['a long run']))).toBe(true)
    expect(repeatsExample('…', new Set(['']))).toBe(false)
  })

  test('the meanings offered are every entry of the spelling, in extract order, as the pack would keep them', () => {
    const { result, entryOf } = simpleResult('run', [
      { word: 'run', pos: 'verb', senses: [
        { glosses: ['If you [[run]], you go quickly.'], examples: [{ text: 'I must run.' }, { text: 'I like to run.' }, { text: 'She runs daily.' }] },
        { glosses: [] },
        { glosses: ['If a machine runs, it works.'] },
      ] },
      { word: 'Run', pos: 'name', senses: [{ glosses: ['A river.'] }] },
      { word: 'run', pos: 'noun', senses: [{ glosses: [] }] },
      { word: 'run', pos: 'noun', senses: [{ glosses: ['A trip made by a runner.'] }] },
    ])
    expect(result.query).toBe('run')
    expect(result.entries).toEqual([
      { lemma: 'run', partOfSpeech: 'verb', senses: [
        { definition: 'If you run, you go quickly.', examples: ['I must run.', 'I like to run.'] },
        { definition: 'If a machine runs, it works.', examples: [] },
      ] },
      { lemma: 'run', partOfSpeech: 'noun', senses: [{ definition: 'A trip made by a runner.', examples: [] }] },
    ])
    expect(entryOf).toEqual([0, -1, -1, 1])
    expect(result.source.license).toBe('CC BY-SA 4.0')
  })

  test('records that are not objects are left out', () => {
    expect(simpleResult('run', [null, 'run', { word: 'run', pos: 'verb' }]).entryOf).toEqual([-1, -1, -1])
  })
})
