// The files the end-to-end tests download: a small dictionary pack built with
// writePack and five stand-in model files the fake worker accepts, with the
// pins of a manifest that points at the loopback asset server.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { STORED_NAMES, type AssetManifest, type PinnedFile } from '../../../src/assets/manifest'
import { cardFixture } from '@andrepaim/contextual-dictionary-core/card-fixture'
import { compareKeys, writePack, type PackRecord } from '@andrepaim/contextual-dictionary-core/pack'

export const TAG = 'assets-e2e'

export const RECORDS: PackRecord[] = [
  { k: cardFixture.query, e: cardFixture.entries.map(entry => ({
    w: entry.lemma,
    p: entry.partOfSpeech,
    s: entry.senses.map(({ definition, examples }) => examples.length ? [definition, ...examples] : definition),
  })) },
  { k: 'mouse', e: [
    { w: 'mouse', p: 'noun', s: [
      'Any small rodent of the genus Mus, with a long thin tail.',
      ['A quiet or timid person.', 'He was a mouse at parties.'],
      'A hand-held device that is moved over a flat surface to move the cursor on a computer screen.',
    ] },
    { w: 'mouse', p: 'verb', s: ['To hunt for mice.', 'To move cautiously, like a mouse.'] },
  ] },
  { k: 'mice', e: [{ w: 'mice', p: 'noun', f: [{ l: 'mouse', n: 'plural of mouse' }] }] },
  { k: 'bank', e: [
    { w: 'bank', p: 'noun', s: ['An institution where money is kept, lent and borrowed.', 'The sloping ground beside a river or lake.'] },
    { w: 'bank', p: 'verb', s: ['To put money in a bank.'] },
  ] },
  { k: 'leaf', e: [{ w: 'leaf', p: 'noun', s: ['A single sheet of paper in a book.', 'The flat green part of a plant that grows from a stem.'] }] },
  { k: 'neural network', e: [{ w: 'neural network', p: 'noun', s: ['A computer system of connected units, loosely modelled on the brain, that learns from examples.'] }] },
  { k: 'network', e: [{ w: 'network', p: 'noun', s: ['A fabric or structure of cords or wires.', 'A group of connected computers.'] }] },
  { k: 'neural', e: [{ w: 'neural', p: 'adj', s: ['Of or relating to the nerves.'] }] },
  { k: 'cursor', e: [{ w: 'cursor', p: 'noun', s: ['A marker on a screen that shows where text will be entered.', 'The sliding part of a slide rule.'] }] },
]

/** The noun meanings of "mouse" in dictionary order, and as the fake model orders them for the fixture article. */
export const MOUSE_DICTIONARY_ORDER = ['Any small rodent of the genus Mus, with a long thin tail.', 'A quiet or timid person.', 'A hand-held device that is moved over a flat surface to move the cursor on a computer screen.']
export const MOUSE_CONTEXT_ORDER = [MOUSE_DICTIONARY_ORDER[2]!, MOUSE_DICTIONARY_ORDER[0]!, MOUSE_DICTIONARY_ORDER[1]!]

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Bytes that do not compress, so the model download has a visible size and takes several chunks. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = 2463534242
  for (let i = 0; i < length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; out[i] = state & 0xff }
  return out
}

const LETTERS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 66 }, (_, i) => String.fromCharCode(0x410 + i)),
]

export interface AssetFixture {
  /** Transfer bytes by published name. */
  bodies: Map<string, Uint8Array>
  files: { dictionary: PinnedFile[]; model: PinnedFile[] }
  manifest(baseUrl: string): AssetManifest
  bytes(bundle: 'dictionary' | 'model'): number
}

let cached: Promise<AssetFixture> | undefined

export function assetFixture(): Promise<AssetFixture> {
  cached ??= (async () => {
    const encoder = new TextEncoder()
    const pack = await writePack([...RECORDS].sort((a, b) => compareKeys(a.k, b.k)), {
      meta: { language: 'en', source: 'Wiktionary', license: 'CC BY-SA 4.0', createdFrom: 'end-to-end fixture', snapshot: 'test' },
    })
    const weights = new Uint8Array([...encoder.encode('FAKE-ONNX'), ...noise(1_500_000)])
    const metadata = encoder.encode(JSON.stringify({ letters: LETTERS, nota_index: 127, template_version: 'compact-v1', separator: '[unused0]', none_text: 'none of the above', max_length: 2048, model_revision: '8751b577199d1bb95b74fa2457da7065d57100ae' }))
    const identity = (name: string, stored: Uint8Array): [PinnedFile, Uint8Array] => [{ name, size: stored.length, sha256: sha(stored), storedName: name, storedSize: stored.length, storedSha256: sha(stored), encoding: 'identity' }, stored]
    const gzipped = (name: string, storedName: string, stored: Uint8Array): [PinnedFile, Uint8Array] => {
      const transfer = new Uint8Array(gzipSync(stored, { level: 9 }))
      return [{ name, size: transfer.length, sha256: sha(transfer), storedName, storedSize: stored.length, storedSha256: sha(stored), encoding: 'gzip' }, transfer]
    }
    const dictionary = [identity(STORED_NAMES.dictionary, pack)]
    const model = [
      gzipped(`${STORED_NAMES.model}.gz`, STORED_NAMES.model, weights),
      identity(STORED_NAMES.modelMetadata, metadata),
      identity(STORED_NAMES.calibration, encoder.encode('{"temperature":1}')),
      identity(STORED_NAMES.tokenizer, encoder.encode('{"model":{"type":"fake"}}')),
      identity(STORED_NAMES.tokenizerConfig, encoder.encode('{"mask_token":"[MASK]"}')),
    ]
    const files = { dictionary: dictionary.map(([file]) => file), model: model.map(([file]) => file) }
    return {
      bodies: new Map([...dictionary, ...model].map(([file, body]) => [file.name, body])),
      files,
      manifest: baseUrl => ({ tag: TAG, baseUrl, bundles: files }),
      bytes: bundle => files[bundle].reduce((sum, file) => sum + file.size, 0),
    }
  })()
  return cached
}
