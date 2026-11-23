import { describe, expect, test } from 'vitest'
import { CodedError, type ModelLoad, type SenseFormat, type WorkerResponse } from '../../../src/shared/contracts'
import type { SenseSession } from '../../../src/model/session'
import { WARM_UP_RUNS, createWorkerHandler, warmUpPrompt } from '../../../src/model/worker-handler'

const FORMAT: SenseFormat = {
  letters: Array.from({ length: 128 }, (_, i) => `L${i}`), nota_index: 127, none_text: 'none of the above',
  separator: '[unused0]', mask_token: '[MASK]', max_length: 2048, temperature: 1,
}

const LOAD: ModelLoad = {
  type: 'load', model: new ArrayBuffer(4), tokenizer: '{}', tokenizerConfig: '{}', metadata: '{}', calibration: '{}', threads: 2, wasmBase: '/ort/',
}

/** A controllable promise. */
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Answer = Float32Array | 'TOO_LONG' | 'MASK' | 'RUN_FAILED'

/** A session whose answers the test decides; `answer` may be replaced per test. */
function fakeSession(answer: (prompt: string) => Answer | Promise<Answer> = prompt => Float32Array.of(prompt.length)) {
  const session = {
    format: FORMAT,
    prompts: [] as string[],
    released: 0,
    answer,
    async logits(prompt: string) { session.prompts.push(prompt); return session.answer(prompt) },
    async release() { session.released++ },
  }
  return session
}

function harness(open: (load: ModelLoad) => Promise<SenseSession>) {
  const posted: Array<{ message: WorkerResponse; transfer?: Transferable[] }> = []
  let exits = 0
  const loads: ModelLoad[] = []
  const handler = createWorkerHandler({
    post: (message, transfer) => { posted.push(transfer ? { message, transfer } : { message }) },
    exit: () => { exits++ },
    open: load => { loads.push(load); return open(load) },
  })
  return { handler, posted, loads, messages: () => posted.map(entry => entry.message), exits: () => exits }
}

describe('warmUpPrompt', () => {
  test('is a compact-v1 prompt with one mask, five meanings and "none of the above"', () => {
    const prompt = warmUpPrompt(FORMAT)
    const lines = prompt.split('\n')
    expect(lines[0]).toMatch(/\*bank\*/)
    expect(lines.slice(1, 6)).toEqual(['L0. a collection', 'L1. sloping land', 'L2. a financial institution', 'L3. a long ridge', 'L4. a supply held in reserve'])
    expect(lines[6]).toBe('L127. none of the above')
    expect(lines[7]).toBe('[unused0] [MASK]')
    expect(prompt.split('[MASK]')).toHaveLength(2)
  })
})

describe('createWorkerHandler', () => {
  test('loads, runs two warm-up prompts, then answers ready with the format', async () => {
    const session = fakeSession()
    const { handler, posted, loads } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    expect(loads).toEqual([LOAD])
    expect(WARM_UP_RUNS).toBe(2)
    expect(session.prompts).toEqual([warmUpPrompt(FORMAT), warmUpPrompt(FORMAT)])
    expect(posted).toEqual([{ message: { type: 'ready', format: FORMAT } }])
  })

  test('answers failed with the load code', async () => {
    const { handler, messages } = harness(async () => { throw new CodedError('MODEL_MISMATCH') })
    handler.handle(LOAD)
    await handler.settled()
    expect(messages()).toEqual([{ type: 'failed', code: 'MODEL_MISMATCH' }])
  })

  test('answers failed with LOAD_FAILED for an uncoded error', async () => {
    const { handler, messages } = harness(async () => { throw new Error('boom') })
    handler.handle(LOAD)
    await handler.settled()
    expect(messages()).toEqual([{ type: 'failed', code: 'LOAD_FAILED' }])
  })

  test.each([
    ['a refused warm-up', () => 'RUN_FAILED' as const],
    ['a throwing warm-up', () => { throw new Error('run failed') }],
  ])('answers failed with LOAD_FAILED and releases the session after %s', async (_, answer) => {
    const session = fakeSession(answer)
    const { handler, messages } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    expect(messages()).toEqual([{ type: 'failed', code: 'LOAD_FAILED' }])
    expect(session.released).toBe(1)
  })

  test('ignores scores that arrive before ready, as well as a second load', async () => {
    const gate = deferred<SenseSession>()
    const { handler, messages, loads } = harness(() => gate.promise)
    handler.handle(LOAD)
    handler.handle({ type: 'score', id: 1, prompt: 'early' })
    handler.handle(LOAD)
    const session = fakeSession()
    gate.resolve(session)
    await handler.settled()
    expect(loads).toHaveLength(1)
    expect(session.prompts).not.toContain('early')
    expect(messages()).toEqual([{ type: 'ready', format: FORMAT }])
  })

  test('ignores scores after a failed load', async () => {
    const { handler, messages } = harness(async () => { throw new CodedError('SESSION_FAILED') })
    handler.handle(LOAD)
    await handler.settled()
    handler.handle({ type: 'score', id: 1, prompt: 'late' })
    await handler.settled()
    expect(messages()).toEqual([{ type: 'failed', code: 'SESSION_FAILED' }])
  })

  test('answers scored with the logits buffer in the transfer list', async () => {
    const session = fakeSession()
    const { handler, posted } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    handler.handle({ type: 'score', id: 7, prompt: 'abc' })
    await handler.settled()
    const last = posted.at(-1)!
    expect(last.message).toEqual({ type: 'scored', id: 7, logits: Float32Array.of(3) })
    const logits = (last.message as { logits: Float32Array }).logits
    expect(last.transfer).toEqual([logits.buffer])
  })

  test('answers rejected with the session code, or RUN_FAILED when the session throws', async () => {
    const session = fakeSession()
    const { handler, messages } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    session.answer = prompt => {
      if (prompt === 'long') return 'TOO_LONG'
      if (prompt === 'nomask') return 'MASK'
      throw new Error('crash')
    }
    handler.handle({ type: 'score', id: 1, prompt: 'long' })
    handler.handle({ type: 'score', id: 2, prompt: 'nomask' })
    handler.handle({ type: 'score', id: 3, prompt: 'crash' })
    await handler.settled()
    expect(messages().slice(1)).toEqual([
      { type: 'rejected', id: 1, code: 'TOO_LONG' },
      { type: 'rejected', id: 2, code: 'MASK' },
      { type: 'rejected', id: 3, code: 'RUN_FAILED' },
    ])
  })

  test('runs one score at a time, in the order received', async () => {
    const session = fakeSession()
    const { handler, messages } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    const gates = [deferred<Answer>(), deferred<Answer>(), deferred<Answer>()]
    let running = 0, most = 0
    session.answer = async prompt => {
      running++; most = Math.max(most, running)
      const answer = await gates[Number(prompt)]!.promise
      running--
      return answer
    }
    for (const id of [0, 1, 2]) handler.handle({ type: 'score', id, prompt: String(id) })
    await Promise.resolve()
    gates[2]!.resolve(Float32Array.of(2))
    gates[1]!.resolve(Float32Array.of(1))
    gates[0]!.resolve(Float32Array.of(0))
    await handler.settled()
    expect(most).toBe(1)
    expect(messages().slice(1).map(message => (message as { id: number }).id)).toEqual([0, 1, 2])
  })

  test('ignores malformed messages', async () => {
    const session = fakeSession()
    const { handler, messages } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    for (const message of [null, 'score', { type: 'score', id: 'x', prompt: 'a' }, { type: 'score', id: 1 }, { type: 'score', id: 1.5, prompt: 'a' }, { type: 'explode' }]) handler.handle(message)
    await handler.settled()
    expect(messages()).toEqual([{ type: 'ready', format: FORMAT }])
    expect(session.prompts).toHaveLength(WARM_UP_RUNS)
  })

  test('close finishes queued scores, releases the session and exits; later messages are ignored', async () => {
    const session = fakeSession()
    const { handler, messages, exits } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    handler.handle({ type: 'score', id: 1, prompt: 'a' })
    handler.handle({ type: 'close' })
    handler.handle({ type: 'score', id: 2, prompt: 'b' })
    handler.handle(LOAD)
    await handler.settled()
    expect(messages().slice(1)).toEqual([{ type: 'scored', id: 1, logits: Float32Array.of(1) }])
    expect(session.released).toBe(1)
    expect(exits()).toBe(1)
    handler.handle({ type: 'close' })
    await handler.settled()
    expect(exits()).toBe(1)
  })

  test('close during a load releases the new session and never answers ready', async () => {
    const gate = deferred<SenseSession>()
    const { handler, messages, exits } = harness(() => gate.promise)
    handler.handle(LOAD)
    handler.handle({ type: 'close' })
    const session = fakeSession()
    gate.resolve(session)
    await handler.settled()
    expect(messages()).toEqual([])
    expect(session.released).toBe(1)
    expect(exits()).toBe(1)
  })

  test('close during a failing load answers nothing and exits', async () => {
    const gate = deferred<SenseSession>()
    const { handler, messages, exits } = harness(() => gate.promise)
    handler.handle(LOAD)
    handler.handle({ type: 'close' })
    gate.reject(new CodedError('SESSION_FAILED'))
    await handler.settled()
    expect(messages()).toEqual([])
    expect(exits()).toBe(1)
  })

  test('close before any load exits at once', async () => {
    const { handler, exits } = harness(async () => fakeSession())
    handler.handle({ type: 'close' })
    await handler.settled()
    expect(exits()).toBe(1)
  })

  test('close still exits when releasing the session fails', async () => {
    const session = fakeSession()
    session.release = async () => { throw new Error('release failed') }
    const { handler, exits } = harness(async () => session)
    handler.handle(LOAD)
    await handler.settled()
    handler.handle({ type: 'close' })
    await handler.settled()
    expect(exits()).toBe(1)
  })
})
