// The model worker's message handling, kept apart from the Web Worker wiring
// so it can be tested. Same protocol as pdfpal's sense worker:
//
// in:  { type: 'load', ... } | { type: 'score', id, prompt } | { type: 'close' }
// out: { type: 'ready', format } | { type: 'failed', code }
//      { type: 'scored', id, logits } | { type: 'rejected', id, code }
//
// Work runs one message at a time in arrival order. Scores that arrive before
// `ready`, or after a failure or `close`, are ignored. Messages carry prompts
// in and numbers or content-free codes out; nothing is logged.
import { CodedError, type ModelLoad, type SenseFormat, type WorkerResponse } from '../shared/contracts'
import type { SenseSession } from './session'

export interface WorkerHost {
  post(message: WorkerResponse, transfer?: Transferable[]): void
  /** Ends the worker. */
  exit(): void
  /** Creates the session; rejects with a CodedError. */
  open(load: ModelLoad): Promise<SenseSession>
}

export interface WorkerHandler {
  handle(message: unknown): void
  /** Resolves once the work queued so far is done (for tests). */
  settled(): Promise<void>
}

/** Warm-up runs before `ready`, so the first lookup does not pay for ONNX Runtime's first-run allocations. */
export const WARM_UP_RUNS = 2
const WARM_UP_PASSAGE = 'We trained the model on a large *bank* of labelled examples before testing it on new data from the same field.'
const WARM_UP_MEANINGS = ['a collection', 'sloping land', 'a financial institution', 'a long ridge', 'a supply held in reserve']

/** A prompt of typical length in the checkpoint's own format. */
export function warmUpPrompt(format: SenseFormat): string {
  const choices = WARM_UP_MEANINGS.map((text, i) => `${format.letters[i]}. ${text}`)
  choices.push(`${format.letters[format.nota_index]}. ${format.none_text}`)
  return `${WARM_UP_PASSAGE}\n${choices.join('\n')}\n${format.separator} ${format.mask_token}`
}

type State = 'idle' | 'loading' | 'ready' | 'failed' | 'closed'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function createWorkerHandler(host: WorkerHost): WorkerHandler {
  let state: State = 'idle'
  let session: SenseSession | undefined
  let work: Promise<void> = Promise.resolve()
  const queue = (step: () => Promise<void>) => { work = work.then(step) }

  async function load(message: ModelLoad) {
    let opened: SenseSession | undefined
    try {
      opened = await host.open(message)
      const prompt = warmUpPrompt(opened.format)
      for (let i = 0; i < WARM_UP_RUNS; i++) {
        if (!(await opened.logits(prompt) instanceof Float32Array)) throw new CodedError('LOAD_FAILED')
      }
    } catch (error) {
      await opened?.release().catch(() => undefined)
      if (state === 'closed') return
      state = 'failed'
      host.post({ type: 'failed', code: error instanceof CodedError ? error.code : 'LOAD_FAILED' })
      return
    }
    session = opened
    if (state === 'closed') return
    state = 'ready'
    host.post({ type: 'ready', format: opened.format })
  }

  async function score(id: number, prompt: string) {
    let answer: Float32Array | string
    try { answer = await session!.logits(prompt) } catch { answer = 'RUN_FAILED' }
    if (typeof answer === 'string') host.post({ type: 'rejected', id, code: answer })
    else host.post({ type: 'scored', id, logits: answer }, [answer.buffer])
  }

  async function close() {
    await session?.release().catch(() => undefined)
    session = undefined
    host.exit()
  }

  return {
    handle(message) {
      if (!isRecord(message) || state === 'closed') return
      switch (message.type) {
        case 'load':
          if (state !== 'idle') return
          state = 'loading'
          queue(() => load(message as unknown as ModelLoad))
          return
        case 'score':
          if (state !== 'ready' || !Number.isSafeInteger(message.id) || typeof message.prompt !== 'string') return
          { const id = message.id as number, prompt = message.prompt; queue(() => score(id, prompt)) }
          return
        case 'close':
          state = 'closed'
          queue(close)
          return
      }
    },
    settled: () => work,
  }
}
