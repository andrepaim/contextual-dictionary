import { beforeAll, describe, expect, test } from 'vitest'
import { CodedError, type DictionaryEntry, type DictionaryResult } from '../../../src/shared/contracts'
import { memoryByteSource, openWiktionaryDictionary, WiktionaryDictionary, wiktionaryUrl } from '@andrepaim/contextual-dictionary-core'
import { compareKeys, writePack, type PackRecord } from '@andrepaim/contextual-dictionary-core/pack'
import { RECORDS } from '../../fixtures/dict/records'

let dictionary: WiktionaryDictionary
beforeAll(async () => {
  const bytes = await writePack([...RECORDS].sort((a, b) => compareKeys(a.k, b.k)), {
    meta: { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'fixture', snapshot: '2026-10-30' },
    blockSize: 512,
  })
  dictionary = await openWiktionaryDictionary(memoryByteSource(bytes))
})

const define = (text: string, before = '', after = '') => dictionary.define({ text, before, after })
/** "lemma/pos" of each entry, the shape most tests compare. */
const heads = (result: DictionaryResult) => result.entries.map(entry => `${entry.lemma}/${entry.partOfSpeech}`)
const notes = (result: DictionaryResult) => result.entries.map(entry => entry.note)

describe('define: exact spelling and case', () => {
  test('a word lists its entries with meanings and examples, and the source', async () => {
    const result = await define('mouse', 'Drag the ', ' to move the cursor.')
    expect(result.query).toBe('mouse')
    expect(heads(result)).toEqual(['mouse/noun', 'mouse/verb', 'MOUSE/noun'])
    expect(result.entries[0]).toEqual<DictionaryEntry>({
      lemma: 'mouse', partOfSpeech: 'noun', senses: [
        { definition: 'Any small rodent of the genus Mus.', examples: ['a field mouse', 'There is a mouse under the stove.'] },
        { definition: '(computing) A computer input device that moves a pointer.', examples: ['Drag the mouse to move the cursor.'] },
      ],
    })
    expect(result.entries[1]!.senses[1]).toEqual({ definition: 'To move cautiously or furtively.', examples: [] })
    expect(result.entries.every(entry => entry.note === undefined)).toBe(true)
    expect(result.source).toEqual({ name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/mouse' })
  })

  test('a capitalised word at the start of a sentence finds the lower-case entries first', async () => {
    expect(heads(await define('Mouse', '', ' droppings were found.'))).toEqual(['mouse/noun', 'mouse/verb', 'MOUSE/noun'])
    expect(heads(await define('Bank', '', ' of England'))).toEqual(['bank/noun', 'bank/noun', 'bank/verb'])
  })

  test('the spelling as selected comes first', async () => {
    expect(heads(await define('MOUSE'))).toEqual(['MOUSE/noun', 'mouse/noun', 'mouse/verb'])
    expect(heads(await define('Polish'))).toEqual(['Polish/adj', 'polish/noun', 'polish/verb'])
    expect(heads(await define('polish'))).toEqual(['polish/noun', 'polish/verb', 'Polish/adj'])
  })

  test('punctuation and quotes around the selection are ignored', async () => {
    for (const text of ['mouse,', '(mouse)', '“mouse”', "'mouse'", 'mouse.', '"mouse"']) expect(heads(await define(text))[0], text).toBe('mouse/noun')
  })

  test('text is composed to NFC', async () => {
    expect(heads(await define('café'))).toEqual(['café/noun'])
  })

  test('single-letter words are defined', async () => {
    expect(heads(await define('A', '', ' dog barked.'))).toEqual(['a/article'])
  })
})

describe('define: inflections', () => {
  test('a plural shows its base word with a note, then its own entries', async () => {
    const result = await define('mice')
    expect(heads(result)).toEqual(['mouse/noun', 'mice/verb'])
    expect(notes(result)).toEqual(['plural of mouse', undefined])
    expect(result.query).toBe('mice')
    expect(result.source.url).toBe('https://en.wiktionary.org/wiki/mouse')
  })

  test('a pointer shows the base entries of its own part of speech', async () => {
    const ran = await define('ran')
    expect(heads(ran)).toEqual(['run/verb', 'rin/verb'])
    expect(notes(ran)).toEqual(['simple past of run', 'simple past of rin'])
    expect(heads(await define('running'))).toEqual(['running/adj', 'run/verb'])
  })

  test('two pointers to the same entry show it once with both notes', async () => {
    const went = await define('went')
    expect(heads(went)).toEqual(['go/verb'])
    expect(notes(went)).toEqual(['simple past of go; (nonstandard) past participle of go'])
  })

  test('an entry with an inflection and meanings of its own shows both, the inflection first', async () => {
    const better = await define('better')
    expect(heads(better)).toEqual(['well/adv', 'better/adv'])
    expect(notes(better)).toEqual(['comparative form of well: more well', undefined])
  })

  test('pointers keep their place among the entries of a word', async () => {
    const colours = await define('colours')
    expect(heads(colours)).toEqual(['colour/noun', 'colours/noun', 'colour/verb'])
    expect(notes(colours)).toEqual(['plural of colour', undefined, 'third-person singular simple present indicative of colour'])
  })

  test('a chain of inflections reaches the end word, with the first note', async () => {
    const result = await define('chaina')
    expect(heads(result)).toEqual(['chainc/noun'])
    expect(notes(result)).toEqual(['plural of chainb'])
  })

  test('a loop of pointers ends, and the pointer text stands in for the meaning', async () => {
    const result = await define('loopa')
    expect(result.entries).toEqual([{ lemma: 'loopa', partOfSpeech: 'noun', senses: [{ definition: 'plural of loopb', examples: [] }] }])
  })

  test('a pointer to a word that is not in the dictionary keeps its text', async () => {
    const result = await define('Smiths')
    expect(result.entries).toEqual([{ lemma: 'Smiths', partOfSpeech: 'noun', senses: [{ definition: 'plural of Smith', examples: [] }] }])
  })

  test('the pointer depth is an option', async () => {
    const bytes = await writePack([...RECORDS].sort((a, b) => compareKeys(a.k, b.k)), { meta: { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'fixture', snapshot: 'x' } })
    const shallow = await openWiktionaryDictionary(memoryByteSource(bytes), { maxPointerDepth: 1 })
    expect((await shallow.define({ text: 'chaina', before: '', after: '' })).entries).toEqual([{ lemma: 'chaina', partOfSpeech: 'noun', senses: [{ definition: 'plural of chainb', examples: [] }] }])
  })
})

describe('define: compounds around the selection', () => {
  test('the compound comes first, then the word', async () => {
    const result = await define('network', 'a trained neural ', ' learns.')
    expect(heads(result)).toEqual(['neural network/noun', 'network/noun'])
    expect(result.query).toBe('network')
    expect(result.source.url).toBe('https://en.wiktionary.org/wiki/neural_network')
    expect(heads(await define('neural', 'a trained ', ' network learns.'))).toEqual(['neural network/noun', 'neural/adj'])
  })

  test('the longest compound wins', async () => {
    expect(heads(await define('neural', 'an artificial ', ' network is'))).toEqual(['artificial neural network/noun', 'neural/adj'])
    expect(heads(await define('neural network', 'an artificial ', ' is'))).toEqual(['artificial neural network/noun', 'neural network/noun'])
  })

  test('an inflected compound goes through its pointer', async () => {
    const result = await define('networks', 'deep neural ', ' learn')
    expect(heads(result)).toEqual(['neural network/noun', 'network/noun'])
    expect(notes(result)).toEqual(['plural of neural network', undefined])
  })

  test('punctuation between words stops a compound', async () => {
    expect(heads(await define('network', 'not neural, ', ''))).toEqual(['network/noun'])
    expect(heads(await define('neural', '', '. Network'))).toEqual(['neural/adj'])
    expect(heads(await define('network', 'neural (', ' here)'))).toEqual(['network/noun'])
  })

  test('a compound that reaches into function words of the context comes after the word', async () => {
    expect(heads(await define('bank', 'She paid at the ', ' today.'))).toEqual(['bank/noun', 'bank/noun', 'bank/verb', 'at the bank/prep_phrase'])
    expect(heads(await define('running', 'still in the ', ' for the prize'))).toEqual(['running/adj', 'run/verb', 'in the running/prep_phrase'])
    // Content words at the edges keep the compound first.
    expect(heads(await define('went', 'She ', ' home.'))).toEqual(['go home/verb', 'go/verb'])
    expect(heads(await define('network', 'the neural ', ' of'))).toEqual(['neural network/noun', 'network/noun'])
  })

  test('compounds with apostrophes', async () => {
    expect(heads(await define('roll', "some rock 'n' ", ' music'))).toEqual(["rock 'n' roll/noun", 'roll/verb'])
    expect(heads(await define("rock ’n’ roll"))).toEqual(["rock 'n' roll/noun"])
  })

  test('a phrase that is not an entry has no entries', async () => {
    expect((await define('purple mouse')).entries).toEqual([])
  })

  test('the compound length is an option', async () => {
    const bytes = await writePack([...RECORDS].sort((a, b) => compareKeys(a.k, b.k)), { meta: { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'fixture', snapshot: 'x' } })
    const short = await openWiktionaryDictionary(memoryByteSource(bytes), { maxCompoundWords: 2 })
    expect(heads(await short.define({ text: 'neural', before: 'an artificial ', after: ' network is' }))).toEqual(['neural network/noun', 'neural/adj'])
  })
})

describe('define: apostrophes and hyphens', () => {
  test('curly and straight apostrophes find the same entry', async () => {
    expect(heads(await define('don’t'))).toEqual(["don't/verb"])
    expect(heads(await define("Don't"))).toEqual(["don't/verb"])
    expect(heads(await define('o’clock'))).toEqual(["o'clock/adv"])
    expect(heads(await define("'tis"))).toEqual(["'tis/contraction"])
    expect(heads(await define('‘Tis'))).toEqual(["'tis/contraction"])
  })

  test('a possessive finds its word', async () => {
    expect(heads(await define("dog's"))).toEqual(['dog/noun'])
    expect(heads(await define('dog’s'))).toEqual(['dog/noun'])
    expect(heads(await define('dogs’'))).toEqual(['dog/noun'])
  })

  test('Unicode hyphens are hyphens', async () => {
    expect(heads(await define('e‐mail'))).toEqual(['e-mail/noun'])
  })

  test('half of a hyphenated word is completed from the context, then defined on its own', async () => {
    const known = await define('known', 'a well-', ' fact')
    expect(heads(known)).toEqual(['well-known/adj', 'known/adj'])
    expect(known.query).toBe('well-known')
    expect(heads(await define('well', 'a ', '-known fact'))).toEqual(['well-known/adj', 'well/adv', 'well/noun'])
  })

  test('a completion that finds nothing falls back to the selection', async () => {
    expect(heads(await define('mouse', 'xyz', ''))).toEqual(['mouse/noun', 'mouse/verb', 'MOUSE/noun'])
  })

  test('a hyphenated word without an entry falls back to its parts, the last first', async () => {
    expect(heads(await define('self-attention'))).toEqual(['attention/noun', 'self/noun'])
  })
})

describe('define: suffixes as a last resort', () => {
  test('regular inflections of words without their own entry', async () => {
    expect(heads(await define('unfriended'))).toEqual(['unfriend/verb'])
    expect(heads(await define('googling'))).toEqual(['google/verb'])
    expect(heads(await define('stopped'))).toEqual(['stop/verb'])
    expect(heads(await define('flies'))).toEqual(['fly/verb'])
    expect(heads(await define('happier'))).toEqual(['happy/adj'])
    expect(heads(await define('dogs'))).toEqual(['dog/noun'])
  })

  test('short words are not stripped', async () => {
    expect((await define('as')).entries).toEqual([])
  })
})

describe('define: nothing to define', () => {
  test('an unknown word has no entries but still a source link', async () => {
    const result = await define('qwertyuiop')
    expect(result).toEqual({ query: 'qwertyuiop', entries: [], source: { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/qwertyuiop' } })
  })

  test('empty selections, numbers, punctuation and long passages have no entries', async () => {
    for (const text of ['', '   ', '42', '!!!', 'one two three four five']) expect((await define(text)).entries, text).toEqual([])
    expect((await define('one two three four five')).query).toBe('one two three four five')
  })
})

describe('errors and helpers', () => {
  test('a failing record source rejects with its coded error', async () => {
    const broken = new WiktionaryDictionary({ get: () => Promise.reject(new CodedError('PACK_CORRUPT')) })
    await expect(broken.define({ text: 'mouse', before: '', after: '' })).rejects.toMatchObject({ code: 'PACK_CORRUPT' })
  })

  test('wiktionaryUrl encodes the title the way Wiktionary links do', () => {
    expect(wiktionaryUrl('neural network')).toBe('https://en.wiktionary.org/wiki/neural_network')
    expect(wiktionaryUrl("don't")).toBe("https://en.wiktionary.org/wiki/don't")
    expect(wiktionaryUrl('café')).toBe('https://en.wiktionary.org/wiki/caf%C3%A9')
    expect(wiktionaryUrl('a/b?c#d')).toBe('https://en.wiktionary.org/wiki/a%2Fb%3Fc%23d')
  })

  test('a lookup reads the records it needs and no more', async () => {
    const records = new Map<string, PackRecord>(RECORDS.map(record => [record.k, record]))
    const asked: string[] = []
    const counting = new WiktionaryDictionary({ get: async key => { asked.push(key); return records.get(key) } })
    await counting.define({ text: 'mouse', before: 'Drag the ', after: ' to move the cursor.' })
    expect(asked.length).toBeLessThanOrEqual(10)
    expect(asked).toContain('mouse')
  })
})
