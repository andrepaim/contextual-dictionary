import { describe, expect, test } from 'vitest'
import { blockedLookup, heldOutHeadwords, isDevelopmentHeadword, normalizePassage, overlapsTestPassage, shingles, testPassageIndex } from '../../../validation/training-items'

// The training round's data rules (validation/, docs/validation.md, "Training round 1"): which headwords are held out,
// how the remaining headwords are split, and when a training passage is too close to a test passage.
describe('training data rules', () => {
  test('the held-out headwords are the first column of the English set and the lemmas of the hand-written set', () => {
    const wiktionary = 'word\tpos\tmeaning\texample_sha256_16\tstratum\nhep\tadj\t0\t7f8db79b694bd585\t2\nbank\tnoun\t3\t0123456789abcdef\t17–32\n'
    const written = '# id\tlemma\tpart of speech\tmeaning index\tstart\n# a comment line\nw001\tbank\tnoun\t0\t(countable) An institution\nw002\tfire\tverb\t1\tTo shoot\n\n'
    expect([...heldOutHeadwords(wiktionary, written)].sort()).toEqual(['bank', 'fire', 'hep'])
  })

  test('a headword is on the development side when its seeded hash falls in the first share of the hash space', () => {
    // sha256("cd-train-r1\naugust") starts 0x0731…, 0.0281 of 2^32; "dictionary" 0.4271.
    expect(isDevelopmentHeadword('august', 'cd-train-r1', 0.04)).toBe(true)
    expect(isDevelopmentHeadword('dictionary', 'cd-train-r1', 0.04)).toBe(false)
    expect(isDevelopmentHeadword('august', 'cd-train-r1', 0.02)).toBe(false)
    expect(isDevelopmentHeadword('bank', 'another-seed', 0)).toBe(false)
    expect(isDevelopmentHeadword('bank', 'another-seed', 1)).toBe(true)
  })

  test('the split is by headword and takes about the requested share', () => {
    const words = Array.from({ length: 20_000 }, (_, i) => `w${i}`)
    const share = words.filter(word => isDevelopmentHeadword(word, 'cd-train-r1', 0.04)).length / words.length
    expect(share).toBeGreaterThan(0.035)
    expect(share).toBeLessThan(0.045)
    expect(isDevelopmentHeadword('w7', 'cd-train-r1', 0.04)).toBe(isDevelopmentHeadword('w7', 'cd-train-r1', 0.04))
  })

  test('passages are compared without case, punctuation or extra white space', () => {
    expect(normalizePassage('  The  "Bank" — of the river!\nIt rose. ')).toBe('the bank of the river it rose')
    expect(normalizePassage('Ça va, 3 × 4?')).toBe('a va 3 4')
  })

  test('shingles are the runs of ten consecutive words', () => {
    expect(shingles('one two three', 10).size).toBe(0)
    const words = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ')
    expect([...shingles(words, 10)]).toEqual(['w0 w1 w2 w3 w4 w5 w6 w7 w8 w9', 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10', 'w2 w3 w4 w5 w6 w7 w8 w9 w10 w11'])
  })

  test('a passage overlaps a test passage when it equals one after normalisation or shares ten consecutive words with one', () => {
    const index = testPassageIndex(['She sat on the grassy bank of the river and watched the boats.', 'Short one.'])
    expect(overlapsTestPassage('she sat on the GRASSY bank of the river, and watched the boats', index)).toBe(true)
    expect(overlapsTestPassage('short one', index)).toBe(true)
    expect(overlapsTestPassage('Yesterday she sat on the grassy bank of the river and slept.', index)).toBe(true)
    expect(overlapsTestPassage('She sat on the bank. The river was high and the boats were few.', index)).toBe(false)
  })

  test('an unlabelled item is dropped when its word or any lemma the lookup returns is held out or on the development side', () => {
    const heldOut = new Set(['bank'])
    const isDevelopment = (word: string) => word === 'august'
    expect(blockedLookup('banks', ['bank'], heldOut, isDevelopment)).toBe(true)
    expect(blockedLookup('bank', ['bank', 'banks'], heldOut, isDevelopment)).toBe(true)
    expect(blockedLookup('augusts', ['august'], heldOut, isDevelopment)).toBe(true)
    expect(blockedLookup('river', ['river'], heldOut, isDevelopment)).toBe(false)
  })
})
