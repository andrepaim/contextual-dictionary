import { contextualOrder, isSenseFormat, memoryByteSource, openWiktionaryDictionary, senseRequest } from '@andrepaim/contextual-dictionary-core'
import { writePack } from '@andrepaim/contextual-dictionary-core/pack'

const format = { letters: ['A', 'B', 'C', 'D', 'E'], nota_index: 4, none_text: 'None fits', separator: '[unused0]', mask_token: '[MASK]', max_length: 128, temperature: 1 }

export const expected = {
  formatValid: true,
  source: { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/bank' },
  target: { start: 17, end: 21, text: 'bank' },
  prompt: '🙂 We reached the *bank* just before dark.\nA. A place to keep money.\nB. The land next to a river.\nC. To deposit money.\nE. None fits\n[unused0] [MASK]',
  total: 4,
  positions: [[1, 0, 2], [0]],
  offered: [2, 1],
  firstSense: { definition: 'The land next to a river.', examples: ['We sat on the bank.'] },
  inflection: { lemma: 'bank', note: 'plural of bank' },
  malformedUrl: 'https://en.wiktionary.org/wiki/ba%EF%BF%BDnk',
  none: 'NONE_FITS',
  foreign: { skip: 'NOT_ENGLISH' },
}

export async function exerciseCore() {
  const pack = await writePack([
    { k: 'bank', e: [
      { w: 'bank', p: 'noun', s: ['A place to keep money.', ['The land next to a river.', 'We sat on the bank.'], 'A row of switches.'] },
      { w: 'bank', p: 'verb', s: ['To deposit money.'] },
    ] },
    { k: 'banks', e: [{ w: 'banks', p: 'noun', f: [{ l: 'bank', n: 'plural of bank' }] }] },
  ], {
    blockSize: 64,
    meta: { language: 'en', source: 'Fixture', license: 'MIT', createdFrom: 'Synthetic records', snapshot: 'test' },
  })
  const dictionary = await openWiktionaryDictionary(memoryByteSource(pack), { cacheBlocks: 1 })
  const selection = { text: 'bank', before: '🙂 We reached the ', after: ' just before dark.' }
  const result = await dictionary.define(selection)
  const request = senseRequest(result, selection, format, 3)
  if ('skip' in request) throw new Error(request.skip)
  const order = contextualOrder(result, request, new Float32Array([1, 8, 2, 0, -2]), format)
  if (!order.applied) throw new Error(order.reason)
  const none = contextualOrder(result, request, [1, 8, 2, 0, 8], format)
  const inflection = (await dictionary.define({ text: 'banks' })).entries[0]
  return {
    formatValid: isSenseFormat(format), source: result.source,
    target: request.target, prompt: request.prompt, total: request.total,
    positions: order.positions, offered: order.offered,
    firstSense: order.result.entries[0]?.senses[0],
    inflection: { lemma: inflection?.lemma, note: inflection?.note },
    malformedUrl: (await dictionary.define({ text: 'ba\uD800nk' })).source.url,
    none: none.applied ? undefined : none.reason,
    foreign: senseRequest(result, { text: 'bank', before: 'Ils ont vu le ', after: ' près de la rivière.' }, format),
  }
}
