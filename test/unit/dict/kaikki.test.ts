import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import { cleanMarkup, DEFAULT_SCOPE, joinGlosses, pickExamples, senseText, transformEntry, type KaikkiSense } from '../../../src/dict/kaikki'

const extract = fs.readFileSync(new URL('../../fixtures/dict/kaikki-extract.ndjson', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
const find = (word: string, pos?: string, nth = 0) => extract.filter(r => r.word === word && (pos === undefined || r.pos === pos))[nth]!

describe('cleanMarkup', () => {
  test('removes templates, keeps link text, strips HTML tags and bold or italic quotes', () => {
    expect(cleanMarkup('God; {{n-g|the name used for God in scripture')).toBe('God; the name used for God in scripture')
    expect(cleanMarkup('A [[link|linked]] word and a [[plain]] one, a [[passive#Adjective|]] form.')).toBe('A linked word and a plain one, a passive form.')
    expect(cleanMarkup('Area in m<sup>2</sup>&nbsp;or ft<sub>2</sub>, a {{lb|en|rare}} value.')).toBe('Area in m2 or ft2, a value.')
    expect(cleanMarkup("The '''bold''' and ''italic'' parts; the prime in NR''₂ stays.")).toBe("The bold and italic parts; the prime in NR''₂ stays.")
    expect(cleanMarkup('line<br/>break and <span class="x">span</span>')).toBe('line break and span')
    expect(cleanMarkup('the labiovelar approximant [[[w]]] and {{nested|{{inner}}}} text')).toBe('the labiovelar approximant [w] and text')
    expect(cleanMarkup('A sloping [[roof], a lean-to')).toBe('A sloping roof], a lean-to')
    expect(cleanMarkup('&amp; &lt;b&gt; &quot;q&quot; &#39;s &#x41; &#66;')).toBe('& <b> "q" \'s A B')
  })

  test('leaves text that only looks like markup', () => {
    for (const text of ['The operator <=> compares; Procter & Gamble; &trade; stays.', 'a < b and c > d', "sulfinamidine RS(=NR')NR''₂", 'braces { and } alone'])
      expect(cleanMarkup(text)).toBe(text)
  })

  test('collapses white space and gives an empty string for nothing left', () => {
    expect(cleanMarkup('  two\n\nlines  ')).toBe('two lines')
    expect(cleanMarkup('{{rfdef|en}}')).toBe('')
    expect(cleanMarkup('   ')).toBe('')
  })
})

describe('joinGlosses', () => {
  test('one level is the gloss itself', () => {
    expect(joinGlosses(['To move swiftly.'])).toBe('To move swiftly.')
  })

  test('a sub-meaning follows its parent after a colon', () => {
    expect(joinGlosses(['To move swiftly.', 'To move forward quickly upon two feet.'])).toBe('To move swiftly: To move forward quickly upon two feet.')
    expect(joinGlosses(['Of a ship:', 'Afloat.'])).toBe('Of a ship: Afloat.')
  })

  test('a sub-meaning that repeats its parent stands alone', () => {
    expect(joinGlosses(['To move swiftly.', 'To move swiftly. Specifically, of a vehicle: to travel.'])).toBe('To move swiftly. Specifically, of a vehicle: to travel.')
    expect(joinGlosses(['A syntactic marker.', 'A syntactic marker in a question.'])).toBe('A syntactic marker in a question.')
  })

  test('an ellipsis continues the sentence of its parent', () => {
    expect(joinGlosses(['The article used before a noun that is identifiable...', '...because it is known in context.'])).toBe('The article used before a noun that is identifiable because it is known in context.')
    expect(joinGlosses(['Something that is…', '…continued.'])).toBe('Something that is continued.')
  })

  test('three levels fold from the top, and empty levels are skipped', () => {
    expect(joinGlosses(['Used before a noun', 'The definite article...', '...because it is known.'])).toBe('Used before a noun: The definite article because it is known.')
    expect(joinGlosses(['', 'Only this.', ' '])).toBe('Only this.')
    expect(joinGlosses([])).toBe('')
  })
})

describe('senseText', () => {
  const sense = (value: Partial<KaikkiSense>): KaikkiSense => value as KaikkiSense
  test('puts the leading label of the raw gloss in front', () => {
    expect(senseText(sense({ glosses: ['To improve.'], raw_glosses: ['(transitive) To improve.'] }), true)).toBe('(transitive) To improve.')
    expect(senseText(sense({ glosses: ['To hunt mice.'], raw_glosses: ['(intransitive) To hunt mice. [from 12th c.]'] }), true)).toBe('(intransitive) To hunt mice.')
    expect(senseText(sense({ glosses: ['A syntactic marker.', 'Should.'], raw_glosses: ['(auxiliary) A syntactic marker.', '(modal, informal) Should.'] }), true)).toBe('(modal, informal) A syntactic marker: Should.')
  })

  test('ignores labels when asked, and raw glosses that do not match', () => {
    expect(senseText(sense({ glosses: ['To improve.'], raw_glosses: ['(transitive) To improve.'] }), false)).toBe('To improve.')
    expect(senseText(sense({ glosses: ['To improve.'], raw_glosses: ['(transitive) Something else.'] }), true)).toBe('To improve.')
    expect(senseText(sense({ glosses: ['To improve.'], raw_glosses: ['To improve.'] }), true)).toBe('To improve.')
  })

  test('cleans markup and gives undefined for no gloss', () => {
    expect(senseText(sense({ glosses: ['A [[link|linked]] word.'] }), true)).toBe('A linked word.')
    expect(senseText(sense({ glosses: [] }), true)).toBeUndefined()
    expect(senseText(sense({ glosses: ['{{rfdef}}'] }), true)).toBeUndefined()
    expect(senseText(sense({}), true)).toBeUndefined()
    expect(senseText(sense({ glosses: [7 as unknown as string, 'Kept.'] }), true)).toBe('Kept.')
  })
})

describe('pickExamples', () => {
  const options = { maxExamples: 2, maxExampleChars: 240 }
  test('usage examples come before quotations, at most two, none too long', () => {
    expect(pickExamples([
      { text: 'A quotation.', ref: '2001, Book', type: 'quotation' },
      { text: 'an example', type: 'example' },
      { text: 'x'.repeat(241), type: 'example' },
      { text: 'another example' },
    ], options)).toEqual(['an example', 'another example'])
    expect(pickExamples([{ text: 'A quotation.', ref: '2001, Book' }, { text: 'an example', type: 'example' }], options)).toEqual(['an example', 'A quotation.'])
  })

  test('collapses white space, skips malformed and duplicate examples, honours the options', () => {
    expect(pickExamples([{ text: 'two\n  lines' }, { text: 7 }, null, 'text', { text: '   ' }, { text: 'two lines' }, { text: 'third' }] as never, options)).toEqual(['two lines', 'third'])
    expect(pickExamples([{ text: 'abc' }, { text: 'abcdef' }], { maxExamples: 5, maxExampleChars: 3 })).toEqual(['abc'])
    expect(pickExamples([{ text: 'abc' }], { maxExamples: 0, maxExampleChars: 240 })).toEqual([])
    expect(pickExamples(undefined, options)).toEqual([])
  })
})

describe('transformEntry', () => {
  test('keeps definitions with their examples, in order, and drops empty glosses', () => {
    const result = transformEntry(find('mouse', 'noun'), DEFAULT_SCOPE)
    expect(result).toEqual({
      ok: true, key: 'mouse', droppedSenses: 1, cleanedGlosses: 0,
      entry: { w: 'mouse', p: 'noun', s: [
        ['Any small rodent of the genus Mus.', 'a field mouse', 'There is a mouse under the stove.'],
        ['(computing) A computer input device that is moved over a pad or other flat surface to produce a corresponding movement of a pointer on a graphical display.', 'Drag the mouse to move the cursor.', 'He clicked the mouse and waited.'],
      ] },
    })
  })

  test('a meaning without examples is a plain string', () => {
    expect(transformEntry(find('mouse', 'verb'), DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: ['(intransitive) To hunt or catch mice, usually of cats.', 'To move cautiously or furtively.'] } })
  })

  test('inflection senses become pointers with their gloss as the note', () => {
    expect(transformEntry(find('mice', 'noun'), DEFAULT_SCOPE)).toMatchObject({ ok: true, key: 'mice', entry: { w: 'mice', p: 'noun', f: [{ l: 'mouse', n: 'plural of mouse' }] } })
    const went = transformEntry(find('went'), DEFAULT_SCOPE)
    expect(went).toMatchObject({ ok: true, entry: { f: [{ l: 'go', n: 'simple past of go' }, { l: 'go', n: '(nonstandard) past participle of go' }] } })
    expect(went.ok && 's' in went.entry).toBe(false)
    expect(transformEntry(find('better'), DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: ['Used to suggest that something should be done.'], f: [{ l: 'well', n: 'comparative form of well: more well' }] } })
  })

  test('duplicate pointers are written once; a form_of without a word is an ordinary meaning', () => {
    const raw = { word: 'twice', pos: 'noun', senses: [
      { glosses: ['plural of x'], form_of: [{ word: 'x' }] }, { glosses: ['plural of x'], form_of: [{ word: 'x' }] },
      { glosses: ['form of nothing'], form_of: [{}] },
    ] }
    expect(transformEntry(raw, DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: ['form of nothing'], f: [{ l: 'x', n: 'plural of x' }] } })
  })

  test('alternative forms stay ordinary meanings', () => {
    expect(transformEntry(find("don't", 'contraction'), DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: ['(archaic) Contraction of done + it.'] } })
  })

  test('joins multi-level glosses and cleans markup', () => {
    expect(transformEntry(find('run', 'verb'), DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: [
      'To move swiftly.',
      'To move swiftly: To move forward quickly upon two feet by alternately making a short jump off either foot.',
      'To move swiftly. Specifically, of a vehicle: to travel.',
      '(intransitive) To compete in a race.',
    ] } })
    expect(transformEntry(find('markup'), DEFAULT_SCOPE)).toEqual({ ok: true, key: 'markup', droppedSenses: 3, cleanedGlosses: 4, entry: { w: 'markup', p: 'noun', s: [
      'God; the name used for God in scripture',
      'A linked word and a plain one, a passive form.',
      'Area in m2 or ft2, a value.',
      "The bold and italic parts; the prime in NR''₂ stays.",
      'The operator <=> compares; Procter & Gamble; &trade; stays.',
    ] } })
    expect(transformEntry(find('the'), DEFAULT_SCOPE)).toMatchObject({ ok: true, entry: { s: ['The definite article, used before a noun phrase that is definitely identifiable because it is known in context.'] } })
  })

  test('keys are normalised; the spelling is kept', () => {
    expect(transformEntry(find('Polish'), DEFAULT_SCOPE)).toMatchObject({ ok: true, key: 'polish', entry: { w: 'Polish', p: 'adj' } })
    expect(transformEntry({ word: 'Don’t', pos: 'verb', senses: [{ glosses: ['Do not.'] }] }, DEFAULT_SCOPE)).toMatchObject({ ok: true, key: "don't", entry: { w: 'Don’t' } })
  })

  test('skips names, characters, symbols, punctuation, words without a letter, other languages and empty entries', () => {
    const reason = (raw: unknown) => { const result = transformEntry(raw, DEFAULT_SCOPE); return result.ok ? 'kept' : result.reason }
    expect(reason(find('Mouse'))).toBe('excluded-pos')
    expect(reason(find('A', 'character'))).toBe('excluded-pos')
    expect(reason(find('A', 'symbol'))).toBe('excluded-pos')
    expect(reason(find('!'))).toBe('excluded-pos')
    expect(reason(find('&'))).toBe('no-letter')
    expect(reason(find('42'))).toBe('no-letter')
    expect(reason(find('a'))).toBe('kept')
    expect(reason(find('Haus'))).toBe('not-english')
    expect(reason(find('emptyword'))).toBe('no-senses')
    expect(reason(extract.find(r => r.word === undefined))).toBe('no-word')
    expect(reason(null)).toBe('no-word')
    expect(reason({ word: 'x y', pos: 7, senses: [] })).toBe('no-pos')
    expect(reason({ word: 'nosenses', pos: 'noun' })).toBe('no-senses')
  })

  test('tolerates malformed senses and examples', () => {
    expect(transformEntry(find('oddity'), DEFAULT_SCOPE)).toEqual({ ok: true, key: 'oddity', droppedSenses: 1, cleanedGlosses: 0, entry: { w: 'oddity', p: 'noun', s: [['A strange thing.', 'an oddity']] } })
  })

  test('honours the scope options', () => {
    const scope = { ...DEFAULT_SCOPE, maxExamples: 1, labels: false, excludedPos: ['noun'] }
    expect(transformEntry(find('mouse', 'noun'), scope)).toMatchObject({ ok: false, reason: 'excluded-pos' })
    expect(transformEntry(find('mouse', 'verb'), scope)).toMatchObject({ ok: true, entry: { s: ['To hunt or catch mice, usually of cats.', 'To move cautiously or furtively.'] } })
    expect(transformEntry(find('bank', 'noun'), { ...scope, excludedPos: [] })).toMatchObject({ ok: true, entry: { s: [['An institution where one can place and borrow money.', 'She works at a bank.'], 'The sloping side of a river.'] } })
    expect(transformEntry(find('Mouse'), { ...DEFAULT_SCOPE, excludedPos: [] })).toMatchObject({ ok: true, key: 'mouse', entry: { w: 'Mouse', p: 'name' } })
  })
})
