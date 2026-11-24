// Opt-in spot checks of a real pack built by scripts/build-dictionary.ts:
//   CD_TEST_PACK=~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack npx vitest run test/unit/dict/real-pack.test.ts
// Skipped otherwise; automated runs never read the real dictionary.
import { describe, expect, test } from 'vitest'
import fsp from 'node:fs/promises'
import type { ByteSource, DictionaryResult } from '../../../src/shared/contracts'
import { openWiktionaryDictionary, type WiktionaryDictionary } from '@andrepaim/contextual-dictionary-core'

const PACK = process.env.CD_TEST_PACK

/** Reads the file by byte range, as the extension reads its stored copy. */
async function fileSource(file: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await fsp.open(file, 'r')
  const { size } = await handle.stat()
  return {
    size,
    read: async (start, end) => {
      const buffer = new Uint8Array(end - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      return buffer.subarray(0, bytesRead)
    },
    close: () => handle.close(),
  }
}

const heads = (result: DictionaryResult) => result.entries.map(entry => `${entry.lemma}/${entry.partOfSpeech}`)
const meanings = (result: DictionaryResult) => result.entries.reduce((sum, entry) => sum + entry.senses.length, 0)

describe.skipIf(!PACK)('the real pack', () => {
  test('spot checks and timings', { timeout: 60_000 }, async () => {
    const source = await fileSource(PACK!)
    let started = performance.now()
    const dictionary: WiktionaryDictionary = await openWiktionaryDictionary(source)
    const openMs = performance.now() - started
    const timings: Array<{ query: string; coldMs: number; warmMs: number; entries: number; meanings: number; first: string[]; note?: string }> = []
    const check = async (text: string, before = '', after = '') => {
      started = performance.now()
      const result = await dictionary.define({ text, before, after })
      const coldMs = performance.now() - started
      started = performance.now()
      await dictionary.define({ text, before, after })
      const warmMs = performance.now() - started
      timings.push({ query: `${before}[${text}]${after}`, coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2), entries: result.entries.length, meanings: meanings(result), first: heads(result).slice(0, 4), note: result.entries.find(entry => entry.note)?.note })
      return result
    }

    const mouse = await check('mouse', 'Drag the ', ' to move the cursor on screen.')
    expect(heads(mouse)[0]).toBe('mouse/noun')
    expect(mouse.entries[0]!.senses.some(sense => /computer|pointer|cursor/i.test(sense.definition))).toBe(true)
    const bank = await check('bank', 'She deposited the cheque at the ', ' on Monday.')
    expect(heads(bank)).toContain('bank/noun')
    expect(meanings(bank)).toBeGreaterThan(10)
    const run = await check('run', 'I ', ' every morning.')
    expect(heads(run)).toEqual(expect.arrayContaining(['run/verb', 'run/noun']))
    expect(meanings(run)).toBeGreaterThan(80)
    const mice = await check('mice', 'Three blind ', ' ran away.')
    expect(mice.entries[0]).toMatchObject({ lemma: 'mouse', partOfSpeech: 'noun', note: 'plural of mouse' })
    const network = await check('network', 'We trained a neural ', ' on images.')
    expect(heads(network)[0]).toBe('neural network/noun')
    expect(heads(await check('neural network'))[0]).toBe('neural network/noun')
    const capitalised = await check('Running', '', ' is good exercise.')
    expect(heads(capitalised)).toContain('running/noun')
    expect(heads(await check('don’t', 'I ', ' know.'))).toContain("don't/verb")
    expect(heads(await check('o’clock', 'at five ', '.'))).toContain("o'clock/adv")
    expect(heads(await check('giraffe’s', 'the ', ' neck'))[0]).toBe('giraffe/noun')
    expect(heads(await check('went', 'She ', ' home.'))).toEqual(expect.arrayContaining(['go home/verb', 'go/verb']))
    expect((await check('qwzxqvplk')).entries).toEqual([])

    await source.close()
    console.log(JSON.stringify({ openMs: +openMs.toFixed(1), timings }, null, 1))
  })
})
