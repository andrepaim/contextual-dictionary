import { describe, expect, test } from 'vitest'
import { normalizeKey } from '../../../src/dict/keys'

describe('normalizeKey', () => {
  test('lower-cases and composes to NFC', () => {
    expect(normalizeKey('Mouse')).toBe('mouse')
    expect(normalizeKey('ÉCOLE')).toBe('école')
    expect(normalizeKey('café')).toBe('café')
    expect(normalizeKey('CAFÉ')).toBe('café')
  })

  test('turns curly and modifier apostrophes into a straight one', () => {
    expect(normalizeKey('Don’t')).toBe("don't")
    expect(normalizeKey('‘tis')).toBe("'tis")
    expect(normalizeKey('oʼclock')).toBe("o'clock")
    expect(normalizeKey('rock ’n’ roll')).toBe("rock 'n' roll")
    expect(normalizeKey('“quoted”')).toBe('"quoted"')
  })

  test('turns Unicode hyphens into a hyphen-minus, drops soft hyphens, keeps dashes', () => {
    expect(normalizeKey('e‐mail')).toBe('e-mail')
    expect(normalizeKey('well‑known')).toBe('well-known')
    expect(normalizeKey('soft­ware')).toBe('software')
    expect(normalizeKey('Marxism–Leninism')).toBe('marxism–leninism')
  })

  test('collapses and trims white space, keeps compatibility characters', () => {
    expect(normalizeKey('  Neural \n\t Network ')).toBe('neural network')
    expect(normalizeKey('neural network')).toBe('neural network')
    expect(normalizeKey('ﬁne')).toBe('ﬁne')
  })
})
