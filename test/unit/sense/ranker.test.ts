import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RANKER_DEFAULTS, SenseRanker, type SenseRankerOptions } from '../../../src/sense/ranker'
import { CodedError, DEFAULT_SETTINGS, type DictionaryResult, type Selection, type WorkerLike } from '../../../src/shared/contracts'
import { FakeWorker, fakeFormat, type FakeOptions } from './fake-worker'

const source = { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/bank' }
const bank: DictionaryResult = {
  query: 'bank', source,
  entries: [
    { lemma: 'bank', partOfSpeech: 'noun', senses: [
      { definition: 'sloping land beside a body of water', examples: [] },
      { definition: 'a financial institution that accepts deposits', examples: ['he cashed a check at the bank'] },
    ] },
    { lemma: 'bank', partOfSpeech: 'verb', senses: [{ definition: 'tip laterally', examples: [] }] },
  ],
}
const financialFirst = [bank.entries[0]!.senses[1], bank.entries[0]!.senses[0]]
/** A distinct English passage for each lookup, so that none is answered from the cache. */
const passage = (n = 0): Selection => ({ before: `On day ${n} he walked over and deposited all of the money at the `, text: 'bank', after: ' before it closed for the day.' })
const many = (count: number): DictionaryResult => ({
  query: 'run', source,
  entries: [{ lemma: 'run', partOfSpeech: 'verb', senses: Array.from({ length: count }, (_, i) => ({ definition: `meaning ${i}`, examples: [] })) }],
})
const choiceCount = (prompt: string) => prompt.split('\n').length - 3

function setup(fake: FakeOptions = {}, options: Partial<SenseRankerOptions> = {}) {
  const workers: FakeWorker[] = []
  const ranker = new SenseRanker({ createWorker: () => { const worker = new FakeWorker(fake); workers.push(worker); return worker }, ...options })
  return { ranker, workers, last: () => workers.at(-1)! }
}
/** Lets fake time pass, running timers and the promises they settle. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms)
async function ready(ranker: SenseRanker, loadMs = 0) {
  ranker.warm()
  await pass(loadMs + 1)
  expect(ranker.status()).toEqual({ state: 'ready' })
}
/** Settles `work` after `ms` of fake time, recording when it settled. */
async function after<T>(ms: number, work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now()
  let settledAt = -1
  const tracked = work.then(value => { settledAt = Date.now(); return value })
  await pass(ms)
  const value = await tracked
  return { value, ms: settledAt - start }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('SenseRanker, ported from pdfpal', () => {
  test('a lookup before the model is ready gets dictionary order at once, and the loaded model then orders meanings', async () => {
    const { ranker } = setup({ loadMs: 300, prefer: 'financial' })
    ranker.warm()
    expect(ranker.status().state).toBe('loading')
    // Resolves without any time passing.
    expect(await ranker.order(bank, passage())).toBe(bank)
    const settled = ranker.settled()
    await pass(300)
    expect(await settled).toEqual({ state: 'ready' })
    const warm = await after(1, ranker.order(bank, passage()))
    expect(warm.value.entries[0]!.senses).toEqual(financialFirst)
    expect(warm.value.entries[1]).toEqual(bank.entries[1])
    expect(ranker.stats.scored).toBe(1)
    expect(ranker.stats.applied).toBe(1)
    await ranker.close()
  })

  test('the first lookup starts loading when nothing warmed the model', async () => {
    const { ranker } = setup({ prefer: 'financial' })
    expect(ranker.status().state).toBe('idle')
    expect(await ranker.order(bank, passage())).toBe(bank)
    expect(ranker.status().state).toBe('loading')
    await pass(1)
    expect((await ranker.settled()).state).toBe('ready')
    expect((await after(1, ranker.order(bank, passage()))).value.entries[0]!.senses).toEqual(financialFirst)
    await ranker.close()
  })

  test('nothing is sent to the model when every entry has one meaning or the input is unsupported', async () => {
    const { ranker, last } = setup({ prefer: 'financial' })
    await ready(ranker)
    const single: DictionaryResult = { ...bank, entries: [bank.entries[1]!] }
    expect(await ranker.order(single, passage())).toBe(single)
    expect(await ranker.order(bank, { before: 'Ele depositou o dinheiro no ', text: 'bank', after: ' antes de fechar para o dia.' })).toBe(bank)
    expect(await ranker.order(bank, { ...passage(), after: ' see footnote*' })).toBe(bank)
    expect(ranker.stats.scored).toBe(0)
    expect(ranker.stats.skipped).toBe(3)
    expect(last().prompts).toEqual([])
    await ranker.close()
  })

  test('a lookup over its time budget gets dictionary order, and the late answer serves the same lookup later', async () => {
    const { ranker } = setup({ scoreMs: 300, prefer: 'financial' }, { budgetMs: 80 })
    await ready(ranker)
    const late = await after(80, ranker.order(bank, passage()))
    expect(late.value).toBe(bank)
    expect(late.ms).toBe(80)
    expect(ranker.stats.timedOut).toBe(1)
    await pass(250)
    expect((await ranker.order(bank, passage())).entries[0]!.senses).toEqual(financialFirst)
    expect(ranker.stats.cached).toBe(1)
    expect(ranker.stats.scored).toBe(1)
    await ranker.close()
  })

  test('a newer lookup replaces one still waiting for the model; the running one completes', async () => {
    const { ranker, last } = setup({ scoreMs: 150, prefer: 'financial' }, { budgetMs: 2000 })
    await ready(ranker)
    const finished: string[] = []
    const track = (name: string, work: Promise<DictionaryResult>) => work.then(result => { finished.push(name); return result })
    const first = track('first', ranker.order(bank, passage(1)))
    const replaced = track('replaced', ranker.order(bank, passage(2)))
    const latest = track('latest', ranker.order(bank, passage(3)))
    expect(await replaced).toBe(bank)
    await pass(300)
    expect((await first).entries[0]!.senses).toEqual(financialFirst)
    expect((await latest).entries[0]!.senses).toEqual(financialFirst)
    expect(finished).toEqual(['replaced', 'first', 'latest'])
    expect(ranker.stats.superseded).toBe(1)
    expect(ranker.stats.scored).toBe(2)
    expect(last().prompts.map(prompt => prompt.match(/day (\d)/)![1])).toEqual(['1', '3'])
    await ranker.close()
  })

  test('a cancelled lookup returns at once, and a cancelled queued lookup is never scored', async () => {
    const { ranker } = setup({ scoreMs: 200, prefer: 'financial' }, { budgetMs: 2000 })
    await ready(ranker)
    const running = new AbortController(), queued = new AbortController()
    const first = ranker.order(bank, passage(1), running.signal)
    const second = ranker.order(bank, passage(2), queued.signal)
    await pass(20)
    running.abort(); queued.abort()
    expect(await first).toBe(bank)
    expect(await second).toBe(bank)
    await pass(250)
    expect(ranker.stats.scored).toBe(1)
    const aborted = new AbortController(); aborted.abort()
    expect(await ranker.order(bank, passage(3), aborted.signal)).toBe(bank)
    expect(ranker.stats.scored).toBe(1)
    await ranker.close()
  })

  test('a model that "fits none" or rejects the prompt leaves dictionary order', async () => {
    const none = setup({ prefer: 'financial', none: 9 }).ranker
    const rejected = setup({ prefer: 'financial', rejectCode: 'TOO_LONG' }).ranker
    await ready(none); await ready(rejected)
    expect((await after(1, none.order(bank, passage()))).value).toBe(bank)
    expect((await after(1, rejected.order(bank, passage()))).value).toBe(bank)
    expect(rejected.status().state, 'one rejected prompt does not stop the model').toBe('ready')
    expect(none.stats.applied).toBe(0)
    await Promise.all([none.close(), rejected.close()])
  })

  test('load failures are reported by code and retried only after a pause', async () => {
    const { ranker, workers } = setup({ fail: 'MODEL_MISMATCH' }, { retryMs: 200 })
    ranker.warm()
    await pass(1)
    expect(await ranker.settled()).toEqual({ state: 'failed', code: 'MODEL_MISMATCH' })
    expect(workers[0]!.terminated).toBe(true)
    expect(await ranker.order(bank, passage())).toBe(bank)
    expect(ranker.status().state, 'no reload before the pause').toBe('failed')
    await pass(250)
    await ranker.order(bank, passage())
    expect(ranker.status().state).toBe('loading')
    expect(workers).toHaveLength(2)
    await ranker.close()
  })

  test('a load that takes too long is abandoned', async () => {
    const { ranker, last } = setup({ loadMs: 5000 }, { loadTimeoutMs: 100 })
    ranker.warm()
    const settled = ranker.settled()
    await pass(100)
    expect(await settled).toEqual({ state: 'failed', code: 'LOAD_TIMEOUT' })
    expect(last().terminated).toBe(true)
    await ranker.close()
  })

  test('a crashed worker returns dictionary order and is restarted after a pause', async () => {
    const { ranker, workers } = setup({ crashOnScore: true }, { retryMs: 100, budgetMs: 2000 })
    await ready(ranker)
    const crashed = await after(1, ranker.order(bank, passage()))
    expect(crashed.value).toBe(bank)
    expect(crashed.ms).toBeLessThanOrEqual(1)
    expect(ranker.status()).toEqual({ state: 'failed', code: 'WORKER_ERROR' })
    expect(workers[0]!.terminated).toBe(true)
    await pass(150)
    await ready(ranker)
    expect(workers).toHaveLength(2)
    await ranker.close()
  })

  test('a worker stuck on one prompt is stopped', async () => {
    const { ranker, last } = setup({ scoreMs: 10_000 }, { budgetMs: 50, runTimeoutMs: 200 })
    await ready(ranker)
    expect((await after(50, ranker.order(bank, passage()))).value).toBe(bank)
    await pass(150)
    expect(ranker.status()).toEqual({ state: 'failed', code: 'WORKER_TIMEOUT' })
    expect(last().terminated).toBe(true)
    await ranker.close()
  })

  test('closing stops the worker and later lookups keep dictionary order', async () => {
    const { ranker, last } = setup({ loadMs: 50, scoreMs: 500, prefer: 'financial' }, { budgetMs: 2000 })
    await ready(ranker, 50)
    const pending = ranker.order(bank, passage(1))
    await pass(20)
    await ranker.close()
    expect(await pending).toBe(bank)
    expect(ranker.status()).toEqual({ state: 'closed' })
    expect(last().posted.at(-1)).toEqual({ type: 'close' })
    expect(last().terminated).toBe(true)
    expect(await ranker.order(bank, passage(2))).toBe(bank)
    ranker.warm()
    expect(ranker.status()).toEqual({ state: 'closed' })
    expect(await ranker.settled()).toEqual({ state: 'closed' })
    await ranker.close()
  })

  test('a factory that reports a missing model fails with its code, and lookups keep dictionary order', async () => {
    const ranker = new SenseRanker({ createWorker: () => { throw new CodedError('MODEL_MISSING') } })
    ranker.warm()
    await pass(1)
    expect(await ranker.settled()).toEqual({ state: 'failed', code: 'MODEL_MISSING' })
    expect(await ranker.order(bank, passage())).toBe(bank)
    await ranker.close()
  })
})

describe('SenseRanker, worker creation', () => {
  test('an asynchronous factory is awaited', async () => {
    const workers: FakeWorker[] = []
    const ranker = new SenseRanker({ createWorker: async () => { await Promise.resolve(); const worker = new FakeWorker({ prefer: 'financial' }); workers.push(worker); return worker } })
    await ready(ranker)
    expect((await after(1, ranker.order(bank, passage()))).value.entries[0]!.senses).toEqual(financialFirst)
    await ranker.close()
    expect(workers[0]!.terminated).toBe(true)
  })

  test('a factory that fails without a code reports WORKER_START_FAILED', async () => {
    const ranker = new SenseRanker({ createWorker: () => Promise.reject(new Error('no bytes')) })
    ranker.warm()
    await pass(1)
    expect(ranker.status()).toEqual({ state: 'failed', code: 'WORKER_START_FAILED' })
  })

  test('a worker created after close or after the load timeout is stopped at once', async () => {
    let release!: (worker: WorkerLike) => void
    const worker = new FakeWorker()
    const ranker = new SenseRanker({ createWorker: () => new Promise(resolve => { release = resolve }) })
    ranker.warm()
    await ranker.close()
    release(worker)
    await pass(1)
    expect(worker.terminated).toBe(true)
    expect(ranker.status()).toEqual({ state: 'closed' })

    const slow = new FakeWorker()
    const timed = new SenseRanker({ createWorker: () => new Promise(resolve => { release = resolve }), loadTimeoutMs: 100 })
    timed.warm()
    await pass(100)
    expect(timed.status()).toEqual({ state: 'failed', code: 'LOAD_TIMEOUT' })
    release(slow)
    await pass(1)
    expect(slow.terminated).toBe(true)
    expect(timed.status()).toEqual({ state: 'failed', code: 'LOAD_TIMEOUT' })
  })

  test('warming while loading or ready starts no second worker', async () => {
    const { ranker, workers } = setup({ loadMs: 100 })
    ranker.warm(); ranker.warm()
    await pass(101)
    ranker.warm()
    expect(workers).toHaveLength(1)
    expect(await ranker.settled()).toEqual({ state: 'ready' })
    await ranker.close()
  })

  test('an error event while loading fails the load', async () => {
    const { ranker, last } = setup({ hang: true })
    ranker.warm()
    await pass(1)
    last().raise(new Error('boom'))
    expect(ranker.status()).toEqual({ state: 'failed', code: 'WORKER_ERROR' })
  })
})

describe('SenseRanker, messages', () => {
  test('a failure the ready worker reports stops it with that code', async () => {
    const { ranker, last } = setup()
    await ready(ranker)
    last().emit({ type: 'failed', code: 'OUT_OF_MEMORY' })
    expect(ranker.status()).toEqual({ state: 'failed', code: 'OUT_OF_MEMORY' })
    expect(last().terminated).toBe(true)
  })

  test('malformed messages, unknown ids, a second ready and messages from a replaced worker are ignored', async () => {
    const { ranker, workers } = setup({ prefer: 'financial' }, { retryMs: 0 })
    await ready(ranker)
    const first = workers[0]!
    for (const message of [null, 'ready', { type: 'unknown' }, { type: 'scored', id: 999, logits: new Float32Array(128) }, { type: 'rejected', id: 999, code: 'X' }, { type: 'ready', format: { ...fakeFormat, nota_index: 3 } }]) first.emit(message)
    expect(ranker.status()).toEqual({ state: 'ready' })
    expect((await after(1, ranker.order(bank, passage()))).value.entries[0]!.senses).toEqual(financialFirst)
    first.emit({ type: 'failed', code: 'LATE' })
    await pass(1)
    await ready(ranker)
    // A replaced worker that keeps talking after it was stopped changes nothing.
    first.terminated = false
    first.emit({ type: 'failed', code: 'STALE' })
    first.raise(new Error('stale'))
    expect(ranker.status()).toEqual({ state: 'ready' })
    await ranker.close()
  })

  test('a score that is not a number array leaves dictionary order', async () => {
    const workers: FakeWorker[] = []
    const ranker = new SenseRanker({ createWorker: () => { const worker = new FakeWorker({ hang: true }); workers.push(worker); return worker }, budgetMs: 1000 })
    ranker.warm()
    await pass(1)
    workers[0]!.emit({ type: 'ready', format: fakeFormat })
    const pending = ranker.order(bank, passage())
    const sent = workers[0]!.posted.find(message => message.type === 'score')
    expect(sent).toBeDefined()
    workers[0]!.emit({ type: 'scored', id: (sent as { id: number }).id, logits: 'not numbers' })
    expect(await pending).toBe(bank)
    expect(ranker.status()).toEqual({ state: 'ready' })
    await ranker.close()
  })

  test('a ready message without a usable format fails the load', async () => {
    const { ranker, last } = setup({ hang: true })
    ranker.warm()
    await pass(1)
    last().emit({ type: 'ready', format: { letters: 'abc' } })
    expect(ranker.status()).toEqual({ state: 'failed', code: 'MODEL_FORMAT' })
  })
})

describe('SenseRanker, cache', () => {
  test('answers are cached by prompt, least recently used first out', async () => {
    const { ranker } = setup({ prefer: 'financial' }, { cacheSize: 2 })
    await ready(ranker)
    for (const n of [1, 2]) await after(1, ranker.order(bank, passage(n)))
    expect(ranker.stats.scored).toBe(2)
    await ranker.order(bank, passage(1))
    expect(ranker.stats.cached).toBe(1)
    await after(1, ranker.order(bank, passage(3)))
    // 2 was the least recently used, so it is gone; 1 is still there.
    await ranker.order(bank, passage(1))
    expect(ranker.stats.cached).toBe(2)
    await after(1, ranker.order(bank, passage(2)))
    expect(ranker.stats.scored).toBe(4)
    await ranker.close()
  })

  test('the cache keeps answers across a worker restart', async () => {
    const { ranker, last } = setup({ prefer: 'financial' }, { retryMs: 0 })
    await ready(ranker)
    await after(1, ranker.order(bank, passage()))
    last().emit({ type: 'failed', code: 'CRASH' })
    await ready(ranker)
    expect((await ranker.order(bank, passage())).entries[0]!.senses).toEqual(financialFirst)
    expect(ranker.stats.cached).toBe(1)
    await ranker.close()
  })
})

describe('SenseRanker, candidates and settings', () => {
  test('a lookup with more meanings than maxCandidates offers only the first ones', async () => {
    const { ranker, last } = setup({ prefer: 'meaning 40' }, { maxCandidates: 48 })
    await ready(ranker)
    const result = many(60)
    const ordered = await after(1, ranker.order(result, passage()))
    expect(choiceCount(last().prompts[0]!)).toBe(48)
    expect(ranker.stats.capped).toBe(1)
    expect(ordered.value.entries[0]!.senses[0]!.definition).toBe('meaning 40')
    expect(ordered.value.entries[0]!.senses.slice(48).map(sense => sense.definition)).toEqual(result.entries[0]!.senses.slice(48).map(sense => sense.definition))
    ranker.configure({ maxCandidates: 10 })
    await after(1, ranker.order(result, passage(1)))
    expect(choiceCount(last().prompts[1]!)).toBe(10)
    expect(ranker.stats.capped).toBe(2)
    await ranker.close()
  })

  test('the default cap is the settings default', async () => {
    const { ranker, last } = setup()
    await ready(ranker)
    await after(1, ranker.order(many(100), passage()))
    expect(choiceCount(last().prompts[0]!)).toBe(DEFAULT_SETTINGS.maxCandidates)
    await ranker.close()
  })

  test('prompts are kept within the default length limit, so their time stays near the budget (docs/validation.md)', async () => {
    const { ranker, last } = setup()
    await ready(ranker)
    const long: DictionaryResult = { ...many(30), entries: [{ ...many(30).entries[0]!, senses: many(30).entries[0]!.senses.map(sense => ({ ...sense, definition: `${sense.definition} ${'y'.repeat(120)}` })) }] }
    await after(1, ranker.order(long, passage()))
    const prompt = last().prompts[0]!
    expect(prompt.length).toBeLessThanOrEqual(RANKER_DEFAULTS.maxPromptChars)
    expect(choiceCount(prompt)).toBeGreaterThan(2)
    expect(choiceCount(prompt)).toBeLessThan(30)
    expect(ranker.stats.capped).toBe(1)
    await ranker.close()
  })

  test('the length limit can be changed', async () => {
    const { ranker, last } = setup({}, { maxPromptChars: 100_000 })
    await ready(ranker)
    const long: DictionaryResult = { ...many(30), entries: [{ ...many(30).entries[0]!, senses: many(30).entries[0]!.senses.map(sense => ({ ...sense, definition: `${sense.definition} ${'y'.repeat(120)}` })) }] }
    await after(1, ranker.order(long, passage()))
    expect(choiceCount(last().prompts[0]!)).toBe(Math.min(30, DEFAULT_SETTINGS.maxCandidates))
    await ranker.close()
  })

  test('configure changes the budget of later lookups', async () => {
    const { ranker } = setup({ scoreMs: 500 }, { budgetMs: 1000 })
    await ready(ranker)
    ranker.configure({ budgetMs: 100 })
    const late = await after(100, ranker.order(bank, passage()))
    expect(late.value).toBe(bank)
    expect(late.ms).toBe(100)
    await ranker.close()
  })

  test('a lookup never fails, even on a malformed result', async () => {
    const { ranker } = setup()
    await ready(ranker)
    const broken = { query: 'x', source, entries: null } as unknown as DictionaryResult
    expect(await ranker.order(broken, passage())).toBe(broken)
    await ranker.close()
  })
})

describe('SenseRanker, idle unload', () => {
  test('after idleMs without lookups the worker is closed and the next lookup loads it again', async () => {
    const { ranker, workers } = setup({ prefer: 'financial' }, { idleMs: 1000 })
    await ready(ranker)
    await pass(900)
    await after(1, ranker.order(bank, passage()))
    await pass(900)
    expect(ranker.status(), 'a lookup restarts the idle period').toEqual({ state: 'ready' })
    await pass(200)
    expect(ranker.status()).toEqual({ state: 'idle' })
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' })
    expect(workers[0]!.terminated).toBe(true)
    expect(ranker.stats.unloaded).toBe(1)
    // The cached answer still serves once the model is back.
    expect(await ranker.order(bank, passage())).toBe(bank)
    expect(ranker.status().state).toBe('loading')
    await pass(1)
    expect((await ranker.order(bank, passage())).entries[0]!.senses).toEqual(financialFirst)
    expect(workers).toHaveLength(2)
    await ranker.close()
  })

  test('a prompt in flight delays the unload', async () => {
    const { ranker } = setup({ scoreMs: 1500 }, { idleMs: 1000, budgetMs: 2000, runTimeoutMs: 5000 })
    await ready(ranker)
    const pending = ranker.order(bank, passage())
    await pass(1200)
    expect(ranker.status()).toEqual({ state: 'ready' })
    await pass(300)
    await pending
    await pass(1000)
    expect(ranker.status()).toEqual({ state: 'idle' })
  })

  test('a slow load is not unloaded, and idleMs 0 never unloads', async () => {
    const slow = setup({ loadMs: 1500 }, { idleMs: 1000 }).ranker
    slow.warm()
    await pass(1200)
    expect(slow.status()).toEqual({ state: 'loading' })
    await pass(400)
    expect(slow.status()).toEqual({ state: 'ready' })
    await slow.close()

    const never = setup({}, { idleMs: 0 }).ranker
    await ready(never)
    await pass(24 * 60 * 60 * 1000)
    expect(never.status()).toEqual({ state: 'ready' })
    await never.close()
  })

  test('the default is ten minutes', async () => {
    const { ranker } = setup()
    await ready(ranker)
    await pass(10 * 60 * 1000 - 10)
    expect(ranker.status()).toEqual({ state: 'ready' })
    await pass(20)
    expect(ranker.status()).toEqual({ state: 'idle' })
  })
})

describe('SenseRanker.rank: order details', () => {
  const ORDERED = { status: 'ordered', positions: [[1, 0], [0]], offered: [2, 1], entryPositions: [0, 1] }

  test('an applied order gives the dictionary positions and offered counts; a cached answer gives the same', async () => {
    const { ranker } = setup({ prefer: 'financial' })
    await ready(ranker)
    const fresh = (await after(1, ranker.rank(bank, passage()))).value
    expect(fresh.details).toEqual(ORDERED)
    expect(fresh.result.entries[0]!.senses).toEqual(financialFirst)
    const cached = await ranker.rank(bank, passage())
    expect(ranker.stats.cached).toBe(1)
    expect(cached.details).toEqual(ORDERED)
    expect(cached.result).toEqual(fresh.result)
    expect(ranker.stats.applied).toBe(2)
    await ranker.close()
  })

  test('an order the model leaves as it is still counts as ordered, with the identity positions', async () => {
    const { ranker } = setup({ prefer: 'sloping' })
    await ready(ranker)
    expect((await after(1, ranker.rank(bank, passage()))).value.details).toEqual({ status: 'ordered', positions: [[0, 1], [0]], offered: [2, 1], entryPositions: [0, 1] })
    await ranker.close()
  })

  test('meanings beyond maxCandidates are counted as not offered', async () => {
    const { ranker } = setup({ prefer: 'meaning 3' }, { maxCandidates: 4 })
    await ready(ranker)
    const { details } = (await after(1, ranker.rank(many(6), passage()))).value
    expect(details).toEqual({ status: 'ordered', positions: [[3, 0, 1, 2, 4, 5]], offered: [4], entryPositions: [0] })
    await ranker.close()
  })

  test('an idle or loading model: "loading", in dictionary order, and the lookup starts the load', async () => {
    const { ranker } = setup({ loadMs: 100, prefer: 'financial' })
    const idle = await ranker.rank(bank, passage())
    expect(idle).toEqual({ result: bank, details: { status: 'loading' } })
    expect(idle.result).toBe(bank)
    expect(ranker.status().state).toBe('loading')
    expect((await ranker.rank(bank, passage())).details).toEqual({ status: 'loading' })
    await pass(100)
    expect((await after(1, ranker.rank(bank, passage()))).value.details.status).toBe('ordered')
    await ranker.close()
  })

  test('nothing to reorder: no entries or one meaning each, also before the model is ready (which still starts it)', async () => {
    const { ranker, last } = setup({ prefer: 'financial' })
    const single: DictionaryResult = { ...bank, entries: [bank.entries[1]!] }
    const empty: DictionaryResult = { ...bank, entries: [] }
    expect(await ranker.rank(single, passage())).toEqual({ result: single, details: { status: 'nothing-to-order' } })
    expect(ranker.status().state).toBe('loading')
    await pass(1)
    expect(ranker.status().state).toBe('ready')
    expect((await ranker.rank(single, passage())).details).toEqual({ status: 'nothing-to-order' })
    expect((await ranker.rank(empty, passage())).details).toEqual({ status: 'nothing-to-order' })
    expect(last().prompts).toEqual([])
    expect(ranker.stats.skipped).toBe(2)
    await ranker.close()
  })

  test('a passage that does not look English: "not-english"', async () => {
    const { ranker } = setup({ prefer: 'financial' })
    await ready(ranker)
    const portuguese = { before: 'Ele depositou o dinheiro no ', text: 'bank', after: ' antes de fechar para o dia.' }
    expect(await ranker.rank(bank, portuguese)).toEqual({ result: bank, details: { status: 'not-english' } })
    await ranker.close()
  })

  test('other refused input: "unavailable"', async () => {
    const { ranker } = setup({ prefer: 'financial' })
    await ready(ranker)
    expect(await ranker.rank(bank, { ...passage(), after: ' see footnote*' })).toEqual({ result: bank, details: { status: 'unavailable' } })
    expect(ranker.stats.skipped).toBe(1)
    await ranker.close()
  })

  test('the budget running out before the answer: "timed-out"', async () => {
    const { ranker } = setup({ scoreMs: 300, prefer: 'financial' }, { budgetMs: 80 })
    await ready(ranker)
    const late = await after(80, ranker.rank(bank, passage()))
    expect(late.value).toEqual({ result: bank, details: { status: 'timed-out' } })
    expect(late.value.result).toBe(bank)
    expect(ranker.stats.timedOut).toBe(1)
    await pass(250)
    expect((await ranker.rank(bank, passage())).details).toEqual(ORDERED)
    await ranker.close()
  })

  test('"none of the above" winning: "none-fits"', async () => {
    const { ranker } = setup({ prefer: 'financial', none: 9 })
    await ready(ranker)
    expect((await after(1, ranker.rank(bank, passage()))).value).toEqual({ result: bank, details: { status: 'none-fits' } })
    await ranker.close()
  })

  test('a rejected prompt, unusable scores, a failed or closed model: "unavailable"', async () => {
    const rejected = setup({ prefer: 'financial', rejectCode: 'TOO_LONG' }).ranker
    await ready(rejected)
    expect((await after(1, rejected.rank(bank, passage()))).value).toEqual({ result: bank, details: { status: 'unavailable' } })
    await rejected.close()
    expect(await rejected.rank(bank, passage())).toEqual({ result: bank, details: { status: 'unavailable' } })

    const failed = setup({ fail: 'MODEL_MISMATCH' }, { retryMs: 1000 }).ranker
    failed.warm()
    await pass(1)
    expect(await failed.rank(bank, passage())).toEqual({ result: bank, details: { status: 'unavailable' } })

    const workers: FakeWorker[] = []
    const nan = new SenseRanker({ createWorker: () => { const worker = new FakeWorker({ hang: true }); workers.push(worker); return worker }, budgetMs: 1000 })
    nan.warm()
    await pass(1)
    workers[0]!.emit({ type: 'ready', format: fakeFormat })
    const pending = nan.rank(bank, passage())
    const sent = workers[0]!.posted.find(message => message.type === 'score') as { id: number }
    workers[0]!.emit({ type: 'scored', id: sent.id, logits: new Float32Array(128).fill(Number.NaN) })
    expect(await pending).toEqual({ result: bank, details: { status: 'unavailable' } })
    await nan.close()
  })

  test('a crashed worker: "unavailable"', async () => {
    const { ranker } = setup({ crashOnScore: true }, { budgetMs: 2000 })
    await ready(ranker)
    expect((await after(1, ranker.rank(bank, passage()))).value.details).toEqual({ status: 'unavailable' })
    await ranker.close()
  })

  test('a superseded lookup: "unavailable"; the running and the newest ones are ordered', async () => {
    const { ranker } = setup({ scoreMs: 150, prefer: 'financial' }, { budgetMs: 2000 })
    await ready(ranker)
    const first = ranker.rank(bank, passage(1))
    const replaced = ranker.rank(bank, passage(2))
    const latest = ranker.rank(bank, passage(3))
    expect(await replaced).toEqual({ result: bank, details: { status: 'unavailable' } })
    await pass(300)
    expect((await first).details).toEqual(ORDERED)
    expect((await latest).details).toEqual(ORDERED)
    expect(ranker.stats.superseded).toBe(1)
    await ranker.close()
  })

  test('a cancelled lookup, running or aborted before it starts: "unavailable"', async () => {
    const { ranker } = setup({ scoreMs: 200, prefer: 'financial' }, { budgetMs: 2000 })
    await ready(ranker)
    const running = new AbortController()
    const pending = ranker.rank(bank, passage(1), running.signal)
    await pass(20)
    running.abort()
    expect(await pending).toEqual({ result: bank, details: { status: 'unavailable' } })
    const aborted = new AbortController(); aborted.abort()
    expect(await ranker.rank(bank, passage(2), aborted.signal)).toEqual({ result: bank, details: { status: 'unavailable' } })
    await ranker.close()
  })

  test('a malformed result never fails the lookup: "unavailable"', async () => {
    const { ranker } = setup()
    const broken = { query: 'x', source, entries: null } as unknown as DictionaryResult
    expect(await ranker.rank(broken, passage())).toEqual({ result: broken, details: { status: 'unavailable' } })
    await ready(ranker)
    expect(await ranker.rank(broken, passage())).toEqual({ result: broken, details: { status: 'unavailable' } })
    await ranker.close()
  })

  test('order() returns rank()\'s result alone', async () => {
    const { ranker } = setup({ prefer: 'financial' })
    await ready(ranker)
    const ranked = (await after(1, ranker.rank(bank, passage()))).value
    expect(await ranker.order(bank, passage())).toEqual(ranked.result)
    await ranker.close()
  })
})

describe('SenseRanker.rank: the entry holding the best meaning first', () => {
  const verbFirst = { status: 'ordered', positions: [[0], [0, 1]], offered: [1, 2], entryPositions: [1, 0] }

  test('the entry holding the best meaning moves first; the details give its dictionary position; a cached answer does the same', async () => {
    const { ranker } = setup({ prefer: 'tip laterally' })
    await ready(ranker)
    const fresh = (await after(1, ranker.rank(bank, passage()))).value
    expect(fresh.result.entries.map(entry => entry.partOfSpeech)).toEqual(['verb', 'noun'])
    expect(fresh.result.entries[1]).toEqual(bank.entries[0])
    expect(fresh.details).toEqual(verbFirst)
    expect(await ranker.rank(bank, passage())).toEqual(fresh)
    expect(ranker.stats.cached).toBe(1)
    await ranker.close()
  })

  test('the default margin is the one measured on the development set (docs/validation.md)', () => {
    expect(RANKER_DEFAULTS.entryMargin).toBe(0.25)
  })

  test('below the margin the entries keep dictionary order, and the meanings are still ordered', async () => {
    // The verb's meaning has a probability of about 0.99 against the noun's best of about 0.007.
    const { ranker } = setup({ prefer: 'tip laterally' }, { entryMargin: 0.99 })
    await ready(ranker)
    const { value } = await after(1, ranker.rank(bank, passage()))
    expect(value.result.entries.map(entry => entry.partOfSpeech)).toEqual(['noun', 'verb'])
    expect(value.details).toEqual({ status: 'ordered', positions: [[0, 1], [0]], offered: [2, 1], entryPositions: [0, 1] })
    await ranker.close()
  })

  test('equal scores move nothing', async () => {
    const { ranker } = setup({ prefer: 'no such definition' })
    await ready(ranker)
    expect((await after(1, ranker.rank(bank, passage()))).value.result).toEqual(bank)
    await ranker.close()
  })

  test('"none of the above", a late answer and a passage that is not scored keep the entries in dictionary order', async () => {
    const none = setup({ prefer: 'tip laterally', none: 9 }).ranker
    await ready(none)
    expect((await after(1, none.rank(bank, passage()))).value).toEqual({ result: bank, details: { status: 'none-fits' } })
    await none.close()

    const slow = setup({ scoreMs: 300, prefer: 'tip laterally' }, { budgetMs: 80 }).ranker
    await ready(slow)
    const late = await after(80, slow.rank(bank, passage()))
    expect(late.value.result).toBe(bank)
    expect(late.value.details).toEqual({ status: 'timed-out' })
    await slow.close()

    const skipped = setup({ prefer: 'tip laterally' }).ranker
    await ready(skipped)
    const portuguese = { before: 'Ele depositou o dinheiro no ', text: 'bank', after: ' antes de fechar para o dia.' }
    expect(await skipped.rank(bank, portuguese)).toEqual({ result: bank, details: { status: 'not-english' } })
    await skipped.close()
  })

  test('a lookup with one entry has nothing to move', async () => {
    const { ranker } = setup({ prefer: 'meaning 2' })
    await ready(ranker)
    const { value } = await after(1, ranker.rank(many(3), passage()))
    expect(value.details).toEqual({ status: 'ordered', positions: [[2, 0, 1]], offered: [3], entryPositions: [0] })
    await ranker.close()
  })
})
