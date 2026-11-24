import type { DictionaryResult } from './contracts.js'

/** Synthetic dictionary data for testing both states of the definition card. */
export const cardFixture: DictionaryResult = {
  query: 'glintmark',
  entries: [
    {
      lemma: 'glintmark',
      partOfSpeech: 'noun',
      note: 'also spelled glint-mark',
      senses: [
        {
          definition: 'A bright fleck left by a polishing wheel.',
          examples: ['A glintmark shone on the brass plate.', 'The jeweller buffed away the glintmark.'],
        },
        { definition: 'A reflective sign on a trail.', examples: ['Follow the glintmark at the fork.'] },
        { definition: 'A small flash in a mirror.', examples: [] },
        { definition: 'A tally made with reflective ink.', examples: ['The last glintmark gleamed in the ledger.'] },
      ],
    },
    {
      lemma: 'glintmark',
      partOfSpeech: 'verb',
      senses: [{ definition: 'To mark with a reflective fleck.', examples: ['They glintmark each sign before hanging it.'] }],
    },
    {
      lemma: 'glintmark',
      partOfSpeech: 'adjective',
      senses: [{ definition: 'Marked by a single point of reflected light.', examples: [] }],
    },
    {
      lemma: 'glintmark',
      partOfSpeech: 'adverb',
      senses: [{ definition: 'With a brief flash.', examples: ['The beacon blinked glintmark.'] }],
    },
  ],
  source: { name: 'Fixture Dictionary', license: 'MIT', url: 'https://example.test/dictionary/glintmark' },
}
