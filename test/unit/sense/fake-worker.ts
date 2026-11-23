import type { SenseFormat, WorkerLike, WorkerRequest, WorkerResponse } from '../../../src/shared/contracts'

// A stand-in for the model worker (src/model/) that speaks the same messages
// without a model. Its timing runs on setTimeout, so tests drive it with fake
// timers. Like a worker the factory has already sent `load` to, it starts
// loading when constructed.

export type FakeOptions = {
  /** How long loading and each score take. */
  loadMs?: number
  scoreMs?: number
  /** Report this load failure code instead of becoming ready. */
  fail?: string
  /** Never answer the load. */
  hang?: boolean
  /** Raise an error event as soon as a score is requested. */
  crashOnScore?: boolean
  /** Reject every score with this code. */
  rejectCode?: string
  /** Definitions containing this text get the highest logit. */
  prefer?: string
  /** The "none of the above" logit (default -5). */
  none?: number
}

export const fakeFormat: SenseFormat = {
  letters: Array.from({ length: 128 }, (_, i) => String.fromCharCode(0x400 + i)),
  nota_index: 127, none_text: 'none of the above', separator: '[unused0]', mask_token: '[MASK]', max_length: 2048, temperature: 1,
}

export class FakeWorker implements WorkerLike {
  readonly posted: WorkerRequest[] = []
  terminated = false
  private readonly messageListeners: Array<(event: { data: WorkerResponse }) => void> = []
  private readonly errorListeners: Array<(event: unknown) => void> = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private busyUntil = 0

  constructor(private readonly fake: FakeOptions = {}) {
    if (fake.hang) return
    this.later(fake.loadMs ?? 0, () => this.emit(fake.fail ? { type: 'failed', code: fake.fail } : { type: 'ready', format: fakeFormat }))
  }

  /** The prompts sent for scoring, oldest first. */
  get prompts(): string[] {
    return this.posted.flatMap(message => message.type === 'score' ? [message.prompt] : [])
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message)
    if (this.terminated || message.type !== 'score') return
    if (this.fake.crashOnScore) { this.later(0, () => this.raise(new Error('crashed'))); return }
    // One prompt at a time, like the real worker.
    const start = Math.max(Date.now(), this.busyUntil)
    this.busyUntil = start + (this.fake.scoreMs ?? 0)
    this.later(this.busyUntil - Date.now(), () => {
      if (this.fake.rejectCode) return this.emit({ type: 'rejected', id: message.id, code: this.fake.rejectCode })
      const choices = message.prompt.split('\n').slice(1, -2)
      const logits = new Float32Array(128).fill(-50)
      choices.forEach((line, i) => { logits[i] = this.fake.prefer && line.includes(this.fake.prefer) ? 5 : 0 })
      logits[127] = this.fake.none ?? -5
      this.emit({ type: 'scored', id: message.id, logits })
    })
  }

  addEventListener(type: 'message', listener: (event: { data: WorkerResponse }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  addEventListener(type: 'message' | 'error', listener: ((event: { data: WorkerResponse }) => void) | ((event: unknown) => void)): void {
    if (type === 'message') this.messageListeners.push(listener as (event: { data: WorkerResponse }) => void)
    else this.errorListeners.push(listener as (event: unknown) => void)
  }

  terminate(): void {
    this.terminated = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  /** Delivers a message as if the worker had sent it. */
  emit(data: unknown): void {
    if (this.terminated) return
    for (const listener of this.messageListeners) listener({ data: data as WorkerResponse })
  }

  raise(error: unknown): void {
    if (this.terminated) return
    for (const listener of this.errorListeners) listener(error)
  }

  private later(ms: number, work: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); work() }, ms)
    this.timers.add(timer)
  }
}
