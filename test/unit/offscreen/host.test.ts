import { describe, expect, test } from 'vitest'
import type { Fetch } from '../../../src/assets/download'
import { STORED_NAMES } from '../../../src/assets/manifest'
import { openWiktionaryDictionary } from '../../../src/dict/lookup'
import { SenseRanker } from '../../../src/sense/ranker'
import { CodedError, type DefineAnswer, type DictionaryResult } from '../../../src/shared/contracts'
import type { RuntimeStatus } from '../../../src/shared/offscreen-protocol'
import { gate, until } from '../assets/helpers'
import { hostFixture, MOUSE_SELECTION, settings } from './fixture'

const define = (fixture: Awaited<ReturnType<typeof hostFixture>>, requestId = 'r1', patch = {}, selection = MOUSE_SELECTION) =>
  fixture.host.handle({ type: 'define', requestId, selection }, settings(patch)) as Promise<DefineAnswer>
const nounMeanings = (result: DictionaryResult) => result.entries.find(entry => entry.lemma === 'mouse' && entry.partOfSpeech === 'noun')!.senses.map(sense => sense.definition)
const RODENT_FIRST = ['Any small rodent of the genus Mus.', '(computing) A computer input device that moves a pointer.']
const DEVICE_FIRST = [...RODENT_FIRST].reverse()
const status = (fixture: Awaited<ReturnType<typeof hostFixture>>, patch = {}) => fixture.host.handle({ type: 'status' }, settings(patch)) as Promise<RuntimeStatus>

describe('OffscreenHost: status', () => {
  test('reports both bundles and the model state', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    const answer = await status(fixture)
    expect(answer.bundles.dictionary).toMatchObject({ phase: 'ready', storedBytes: fixture.sizeOf('dictionary') })
    expect(answer.bundles.model).toMatchObject({ phase: 'missing', requiredBytes: fixture.sizeOf('model') })
    expect(answer.ranker).toEqual({ state: 'idle' })
  })

  test('a settings message applies the settings and answers with the status', async () => {
    const fixture = await hostFixture()
    expect(await fixture.host.handle({ type: 'settings' }, settings())).toMatchObject({ ranker: { state: 'idle' } })
  })
})

describe('OffscreenHost: lookups', () => {
  test('without the dictionary a lookup fails with DICTIONARY_MISSING', async () => {
    const fixture = await hostFixture()
    await expect(define(fixture)).rejects.toMatchObject({ code: 'DICTIONARY_MISSING' })
  })

  test('with the dictionary, meanings come in dictionary order', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    const answer = await define(fixture)
    expect(answer.ordered).toBe(false)
    expect(answer.result.query).toBe('mouse')
    expect(nounMeanings(answer.result)).toEqual(RODENT_FIRST)
    expect(fixture.workers).toHaveLength(0)
  })

  test('an unknown word has no entries', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    expect((await define(fixture, 'r1', {}, { text: 'qwzxqv', before: '', after: '' })).result.entries).toEqual([])
  })

  test('the dictionary is opened once and reused', async () => {
    let opened = 0
    const fixture = await hostFixture({}, { openDictionary: source => { opened++; return openWiktionaryDictionary(source) } })
    fixture.install('dictionary')
    await Promise.all([define(fixture, 'a'), define(fixture, 'b')])
    await define(fixture, 'c')
    expect(opened).toBe(1)
  })

  test('a dictionary that fails to open is tried again on the next lookup', async () => {
    let attempts = 0
    const fixture = await hostFixture({}, { openDictionary: source => (++attempts === 1 ? Promise.reject(new CodedError('PACK_CORRUPT')) : openWiktionaryDictionary(source)) })
    fixture.install('dictionary')
    await expect(define(fixture)).rejects.toMatchObject({ code: 'PACK_CORRUPT' })
    expect((await define(fixture, 'r2')).result.entries.length).toBeGreaterThan(0)
  })
})

describe('OffscreenHost: order by context', () => {
  test('turning ordering on warms the installed model with the load message', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    expect(fixture.workers).toHaveLength(1)
    const load = fixture.workers[0]!.posted[0]!
    expect(load).toMatchObject({ type: 'load', threads: 4, wasmBase: 'chrome-extension://id/ort/', metadata: '{"template_version":"compact-v1"}', tokenizerConfig: '{"mask_token":"[MASK]"}' })
    expect((await status(fixture, { orderByContext: true })).ranker).toEqual({ state: 'ready' })
    const answer = await define(fixture, 'r1', { orderByContext: true })
    expect(answer.ordered).toBe(true)
    expect(nounMeanings(answer.result)).toEqual(DEVICE_FIRST)
  })

  test('a lookup with ordering off keeps dictionary order even with the model ready', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: false }))
    expect(fixture.workers[0]!.terminated).toBe(true)
    const answer = await define(fixture, 'r1', { orderByContext: false })
    expect(answer.ordered).toBe(false)
    expect(nounMeanings(answer.result)).toEqual(RODENT_FIRST)
    expect((await status(fixture)).ranker).toEqual({ state: 'idle' })
  })

  test('the settings that come with a lookup are applied first', async () => {
    const fixture = await hostFixture({ prefer: 'computing', loadMs: 50 })
    fixture.install('dictionary'); fixture.install('model')
    // The first lookup after ordering was turned on elsewhere starts the model and gets dictionary order.
    expect((await define(fixture, 'r1', { orderByContext: true })).ordered).toBe(false)
    await fixture.host.idle()
    expect((await define(fixture, 'r2', { orderByContext: true })).ordered).toBe(true)
  })

  test('with ordering on and no model installed, nothing is started', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    const answer = await define(fixture, 'r1', { orderByContext: true })
    await fixture.host.idle()
    expect(answer.ordered).toBe(false)
    expect(fixture.workers).toHaveLength(0)
    expect((await status(fixture, { orderByContext: true })).ranker).toEqual({ state: 'idle' })
  })

  test('the budget comes from the settings; a late answer orders the next lookup of the passage', async () => {
    const fixture = await hostFixture({ prefer: 'computing', scoreMs: 80 })
    fixture.install('dictionary'); fixture.install('model')
    const on = { orderByContext: true, budgetMs: 50 }
    await fixture.host.handle({ type: 'settings' }, settings(on))
    await fixture.host.idle()
    const first = await define(fixture, 'r1', on)
    expect(first.ordered).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 60))
    const second = await define(fixture, 'r2', on)
    expect(second.ordered).toBe(true)
    expect(nounMeanings(second.result)).toEqual(DEVICE_FIRST)
  })

  test('maxCandidates from the settings reaches the ranker', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    const on = { orderByContext: true, maxCandidates: 4 }
    await fixture.host.handle({ type: 'settings' }, settings(on))
    await fixture.host.idle()
    await define(fixture, 'r1', on)
    const prompt = fixture.workers[0]!.prompts[0]!
    expect(prompt.split('\n').length - 3).toBe(4)
  })

  test('cancel-define stops waiting for the model: the lookup gets dictionary order', async () => {
    const fixture = await hostFixture({ prefer: 'computing', scoreMs: 5_000 })
    fixture.install('dictionary'); fixture.install('model')
    const on = { orderByContext: true, budgetMs: 2000 }
    await fixture.host.handle({ type: 'settings' }, settings(on))
    await fixture.host.idle()
    const started = Date.now()
    const pending = define(fixture, 'slow', on)
    await until(() => fixture.workers[0]!.prompts.length === 1)
    expect(await fixture.host.handle({ type: 'cancel-define', requestId: 'slow' }, settings(on))).toBeNull()
    const answer = await pending
    expect(answer.ordered).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await fixture.host.handle({ type: 'cancel-define', requestId: 'unknown' }, settings(on))).toBeNull()
  })

  test('a model that fails to load leaves dictionary order and reports the failure', async () => {
    const fixture = await hostFixture({ fail: 'RUNTIME_FAILED' })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    expect((await status(fixture, { orderByContext: true })).ranker).toEqual({ state: 'failed', code: 'RUNTIME_FAILED' })
    expect((await define(fixture, 'r1', { orderByContext: true })).ordered).toBe(false)
    expect((await status(fixture, { orderByContext: true })).bundles.model.phase).toBe('ready')
  })

  test('a mismatch failure with intact files keeps the model installed and the failure visible', async () => {
    const fixture = await hostFixture({ fail: 'MODEL_MISMATCH' })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    const answer = await status(fixture, { orderByContext: true })
    expect(answer.bundles.model.phase).toBe('ready')
    expect(answer.ranker).toEqual({ state: 'failed', code: 'MODEL_MISMATCH' })
  })

  test('a mismatch failure from a damaged file shows the model as missing so it can be downloaded again', async () => {
    const fixture = await hostFixture({ fail: 'MODEL_MISMATCH', loadMs: 30 })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    // The worker got the files (they were verified on first open), then the stored model changed at the same size.
    await until(() => fixture.workers.length === 1)
    const weights = fixture.store.files.get(STORED_NAMES.model)!
    weights[0] = weights[0]! ^ 0xff
    await fixture.host.idle()
    const answer = await status(fixture, { orderByContext: true })
    expect(answer.bundles.model).toMatchObject({ phase: 'missing', requiredBytes: fixture.manifest.bundles.model[0]!.size })
    expect(answer.ranker).toEqual({ state: 'idle' })
    expect(fixture.store.files.has(STORED_NAMES.model)).toBe(false)
  })

  test('a model file damaged before loading is found by the background check: the model closes and shows as missing', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary'); fixture.install('model')
    const tokenizer = fixture.store.files.get(STORED_NAMES.tokenizer)!
    tokenizer[10] = tokenizer[10]! ^ 0xff
    // Loading does not wait for the files to be hashed.
    expect((await define(fixture, 'r1', { orderByContext: true })).ordered).toBe(false)
    await fixture.host.idle()
    expect(fixture.workers).toHaveLength(1)
    expect(fixture.workers[0]!.terminated).toBe(true)
    const answer = await status(fixture, { orderByContext: true })
    expect(answer.bundles.model.phase).toBe('missing')
    expect(answer.ranker).toEqual({ state: 'idle' })
    expect((await define(fixture, 'r2', { orderByContext: true })).ordered).toBe(false)
  })

  test('the first lookup of a session does not wait for the dictionary to be hashed', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    // Reads of the whole file (the hash) wait; the reader's own reads of header, index and blocks do not.
    const held = gate()
    const open = fixture.store.open.bind(fixture.store)
    fixture.store.open = async name => {
      const source = await open(name)
      return source && { size: source.size, read: async (start, end) => { if (start === 0 && end === source.size) await held.promise; return source.read(start, end) } }
    }
    const answer = await define(fixture)
    expect(nounMeanings(answer.result)).toEqual(RODENT_FIRST)
    let hashed = false
    void fixture.assets.checked().then(() => { hashed = true })
    await Promise.resolve()
    expect(hashed).toBe(false)
    held.open()
    await fixture.host.idle()
    expect(hashed).toBe(true)
    expect((await status(fixture)).bundles.dictionary.phase).toBe('ready')
  })

  test('a dictionary found damaged by the background check is dropped: lookups fail quietly until it is downloaded again', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    const pack = fixture.store.files.get(STORED_NAMES.dictionary)!
    pack[pack.length - 1] = pack[pack.length - 1]! ^ 0xff
    await define(fixture).catch(() => undefined)
    await fixture.host.idle()
    expect((await status(fixture)).bundles.dictionary.phase).toBe('missing')
    await expect(define(fixture, 'r2')).rejects.toMatchObject({ code: 'DICTIONARY_MISSING' })
  })
})

describe('OffscreenHost: downloads', () => {
  test('a confirmed dictionary download makes lookups work without a restart', async () => {
    const fixture = await hostFixture()
    await expect(define(fixture)).rejects.toMatchObject({ code: 'DICTIONARY_MISSING' })
    const started = await fixture.host.handle({ type: 'download', bundle: 'dictionary', acceptBytes: fixture.sizeOf('dictionary') }, settings()) as RuntimeStatus
    expect(['downloading', 'installing', 'ready']).toContain(started.bundles.dictionary.phase)
    await fixture.host.idle()
    expect((await status(fixture)).bundles.dictionary.phase).toBe('ready')
    expect((await define(fixture)).result.entries.length).toBeGreaterThan(0)
  })

  test('a refused download passes the size-changed error on', async () => {
    const fixture = await hostFixture()
    await expect(fixture.host.handle({ type: 'download', bundle: 'model', acceptBytes: 1 }, settings())).rejects.toMatchObject({ code: 'DOWNLOAD_SIZE_CHANGED' })
  })

  test('a model download finishing with ordering on starts the model', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary')
    const on = settings({ orderByContext: true })
    await fixture.host.handle({ type: 'download', bundle: 'model', acceptBytes: fixture.sizeOf('model') }, on)
    // The popup turns ordering on right after confirming; the model is not there yet, so nothing starts.
    await fixture.host.handle({ type: 'settings' }, on)
    await fixture.host.idle()
    expect(fixture.workers).toHaveLength(1)
    expect((await status(fixture, on)).ranker).toEqual({ state: 'ready' })
    expect((await define(fixture, 'r1', on)).ordered).toBe(true)
  })

  test('a model download finishing with ordering off starts nothing', async () => {
    const fixture = await hostFixture()
    await fixture.host.handle({ type: 'download', bundle: 'model', acceptBytes: fixture.sizeOf('model') }, settings({ orderByContext: false }))
    await fixture.host.idle()
    expect((await status(fixture, { orderByContext: false })).bundles.model.phase).toBe('ready')
    expect(fixture.workers).toHaveLength(0)
  })

  test('cancel-download stops the download and leaves nothing installed', async () => {
    const hanging: Fetch = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    const fixture = await hostFixture({}, {}, { fetch: hanging })
    await fixture.host.handle({ type: 'download', bundle: 'dictionary', acceptBytes: fixture.sizeOf('dictionary') }, settings())
    expect((await status(fixture)).bundles.dictionary.phase).toBe('downloading')
    const after = await fixture.host.handle({ type: 'cancel-download', bundle: 'dictionary' }, settings()) as RuntimeStatus
    expect(after.bundles.dictionary).toMatchObject({ phase: 'missing', error: null })
    expect(fixture.store.pendingWrites()).toBe(0)
    expect(await fixture.store.list()).toEqual([])
  })
})

describe('OffscreenHost: removal', () => {
  test('removing the dictionary makes lookups fail quietly again', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    expect((await define(fixture)).result.entries.length).toBeGreaterThan(0)
    const after = await fixture.host.handle({ type: 'remove-assets', bundle: 'dictionary' }, settings()) as RuntimeStatus
    expect(after.bundles.dictionary.phase).toBe('missing')
    await expect(define(fixture, 'r2')).rejects.toMatchObject({ code: 'DICTIONARY_MISSING' })
  })

  test('removing the model closes it and leaves dictionary order', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    const on = settings({ orderByContext: true })
    await fixture.host.handle({ type: 'settings' }, on)
    await fixture.host.idle()
    const after = await fixture.host.handle({ type: 'remove-assets', bundle: 'model' }, on) as RuntimeStatus
    expect(fixture.workers[0]!.terminated).toBe(true)
    expect(after.bundles.model.phase).toBe('missing')
    expect(after.ranker).toEqual({ state: 'idle' })
    expect((await define(fixture, 'r1', { orderByContext: true })).ordered).toBe(false)
    await fixture.host.idle()
    expect(fixture.workers).toHaveLength(1)
  })
})

describe('OffscreenHost: order details', () => {
  const DOG = { text: 'dog', before: 'The old ', after: ' barked at the mailman all night.' }
  /** Every answer carries details, and `ordered` says whether their status is "ordered". */
  const consistent = (answer: DefineAnswer) => {
    expect(answer.order).toBeDefined()
    expect(answer.ordered).toBe(answer.order!.status === 'ordered')
    return answer.order
  }

  test('ordering off: "off", also with the model ready', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    expect(consistent(await define(fixture, 'r1', { orderByContext: false }))).toEqual({ status: 'off' })
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: false }))
    expect(consistent(await define(fixture, 'r2', { orderByContext: false }))).toEqual({ status: 'off' })
  })

  test('ordering on without the model: "no-model", and nothing is started', async () => {
    const fixture = await hostFixture()
    fixture.install('dictionary')
    expect(consistent(await define(fixture, 'r1', { orderByContext: true }))).toEqual({ status: 'no-model' })
    await fixture.host.idle()
    expect(fixture.workers).toHaveLength(0)
  })

  test('nothing to reorder: an unknown word, or a word with one meaning per entry, with or without the model', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary')
    const on = { orderByContext: true }
    expect(consistent(await define(fixture, 'r1', on, { text: 'qwzxqv', before: '', after: '' }))).toEqual({ status: 'nothing-to-order' })
    expect(consistent(await define(fixture, 'r2', on, DOG))).toEqual({ status: 'nothing-to-order' })
    fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings(on))
    await fixture.host.idle()
    expect(consistent(await define(fixture, 'r3', on, DOG))).toEqual({ status: 'nothing-to-order' })
  })

  test('the first lookup while the model starts: "loading"; then "ordered" with positions and offered counts', async () => {
    const fixture = await hostFixture({ prefer: 'computing', loadMs: 50 })
    fixture.install('dictionary'); fixture.install('model')
    const on = { orderByContext: true }
    expect(consistent(await define(fixture, 'r1', on))).toEqual({ status: 'loading' })
    await fixture.host.idle()
    const answer = await define(fixture, 'r2', on)
    const order = consistent(answer)!
    expect(order.status).toBe('ordered')
    expect(nounMeanings(answer.result)).toEqual(DEVICE_FIRST)
    const noun = answer.result.entries.findIndex(entry => entry.lemma === 'mouse' && entry.partOfSpeech === 'noun')
    expect(order.positions![noun]).toEqual([1, 0])
    expect(order.offered).toEqual(answer.result.entries.map(entry => entry.senses.length))
    expect(order.positions).toHaveLength(answer.result.entries.length)
  })

  test('a cancelled lookup: "unavailable"', async () => {
    const fixture = await hostFixture({ prefer: 'computing', scoreMs: 5_000 })
    fixture.install('dictionary'); fixture.install('model')
    const on = { orderByContext: true, budgetMs: 2000 }
    await fixture.host.handle({ type: 'settings' }, settings(on))
    await fixture.host.idle()
    const pending = define(fixture, 'slow', on)
    await until(() => fixture.workers[0]!.prompts.length === 1)
    await fixture.host.handle({ type: 'cancel-define', requestId: 'slow' }, settings(on))
    expect(consistent(await pending)).toEqual({ status: 'unavailable' })
  })

  test('a ranker that throws: dictionary order, "unavailable"', async () => {
    const fixture = await hostFixture({}, {
      createRanker: options => Object.assign(new SenseRanker(options), { rank: () => Promise.reject(new Error('broken')) }),
    })
    fixture.install('dictionary'); fixture.install('model')
    const answer = await define(fixture, 'r1', { orderByContext: true })
    expect(consistent(answer)).toEqual({ status: 'unavailable' })
    expect(nounMeanings(answer.result)).toEqual(RODENT_FIRST)
  })

  test('details are numbers and one status word, never text', async () => {
    const fixture = await hostFixture({ prefer: 'computing' })
    fixture.install('dictionary'); fixture.install('model')
    await fixture.host.handle({ type: 'settings' }, settings({ orderByContext: true }))
    await fixture.host.idle()
    const { order } = await define(fixture, 'r1', { orderByContext: true })
    const values = JSON.stringify(order).match(/"[^"]*"/g)!.filter(text => !['"status"', '"positions"', '"offered"'].includes(text))
    expect(values).toEqual(['"ordered"'])
  })
})
