// Fake ONNX Runtime and tokenizer modules for the model tests. They record
// what the session asks of them and answer the way the real packages do,
// without a model or any WebAssembly.
import type { OrtLike, SenseRuntime, TokenizerModuleLike } from '../../../src/model/session'

/** The Wiktionary-trained checkpoint of training round 1: sha256 of its model.safetensors (docs/validation.md). */
export const REVISION = 'sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3'
/** The checkpoint assets-v1 shipped; its metadata must be refused now. */
export const OLD_REVISION = '8751b577199d1bb95b74fa2457da7065d57100ae'
export const MASK = '[MASK]'
export const MASK_ID = 4
export const CLS_ID = 1
export const SEP_ID = 2

export const LETTERS = Array.from({ length: 128 }, (_, i) => `L${i}`)

export function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    letters: LETTERS, nota_index: 127, template_version: 'compact-v1', separator: '[unused0]',
    none_text: 'none of the above', max_length: 32, model_revision: REVISION,
    calibration: { temperature: 1 }, ...overrides,
  })
}

export const calibration = (temperature: unknown = 1.5) => JSON.stringify({ temperature, version: 'test' })
export const tokenizerConfig = (overrides: Record<string, unknown> = {}) => JSON.stringify({ mask_token: MASK, cls_token: '[CLS]', ...overrides })
export const tokenizerJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({ model: { type: 'fake' }, ...overrides })

export class FakeTensor {
  constructor(readonly type: string, readonly data: BigInt64Array, readonly dims: readonly number[]) {}
}

/**
 * Splits on whitespace: `[MASK]` is token 4, every other word 100 + its
 * length, wrapped in [CLS] … [SEP] like the real tokenizer.
 */
export class FakeTokenizer {
  static instances: FakeTokenizer[] = []
  readonly json: Record<string, unknown>
  readonly config: Record<string, unknown>
  constructor(json: object, config: object) {
    this.json = json as Record<string, unknown>
    this.config = config as Record<string, unknown>
    if (this.json.broken) throw new Error('bad tokenizer')
    FakeTokenizer.instances.push(this)
  }
  encode(text: string): { ids: number[] } {
    if (text.includes('THROW')) throw new Error('encode failed')
    const words = text.split(/\s+/).filter(Boolean)
    return { ids: [CLS_ID, ...words.map(word => word === MASK ? MASK_ID : 100 + word.length), SEP_ID] }
  }
  token_to_id(token: string): number | undefined {
    if (this.json.noMask) return undefined
    return token === MASK ? MASK_ID : undefined
  }
}

export interface FakeOrtOptions {
  /** Logits the session returns; a function of the call number. */
  logits?: (call: number) => { data: ArrayLike<number>; dims: readonly number[] } | undefined
  createError?: Error
  runError?: (call: number) => Error | undefined
}

export interface FakeOrt extends OrtLike {
  calls: {
    create: Array<{ model: Uint8Array; options: unknown; wasm: Record<string, unknown> }>
    run: Array<Record<string, FakeTensor>>
    released: number
    disposed: number
  }
}

export const sequence = (count: number) => Float32Array.from({ length: count }, (_, i) => i / 10)

export function fakeOrt(options: FakeOrtOptions = {}): FakeOrt {
  const calls: FakeOrt['calls'] = { create: [], run: [], released: 0, disposed: 0 }
  const env = { wasm: {} as Record<string, unknown> }
  return {
    calls,
    env,
    Tensor: FakeTensor as unknown as OrtLike['Tensor'],
    InferenceSession: {
      async create(model, sessionOptions) {
        calls.create.push({ model, options: sessionOptions, wasm: { ...env.wasm } })
        if (options.createError) throw options.createError
        return {
          async run(feeds) {
            const call = calls.run.push(feeds as Record<string, FakeTensor>)
            const error = options.runError?.(call)
            if (error) throw error
            const output = options.logits ? options.logits(call) : { data: sequence(130), dims: [1, 130] }
            return output ? { logits: { ...output, dispose: () => { calls.disposed++ } } } : {}
          },
          async release() { calls.released++ },
        }
      },
    },
  }
}

export function fakeRuntime(options: FakeOrtOptions = {}): SenseRuntime & { ort: FakeOrt } {
  return { ort: fakeOrt(options), tokenizers: { Tokenizer: FakeTokenizer } satisfies TokenizerModuleLike }
}

export function loadInput(overrides: Partial<{ model: ArrayBuffer; tokenizer: string; tokenizerConfig: string; metadata: string; calibration: string; threads: number; wasmBase: string }> = {}) {
  return {
    model: new Uint8Array([8, 6, 4, 9]).buffer,
    tokenizer: tokenizerJson(),
    tokenizerConfig: tokenizerConfig(),
    metadata: metadata(),
    calibration: calibration(),
    threads: 4,
    wasmBase: 'chrome-extension://abc/ort/',
    ...overrides,
  }
}

/** A prompt in the compact-v1 shape with `count` candidates. */
export function prompt(count: number, passage = 'Drag the *mouse* to move the cursor'): string {
  const choices = Array.from({ length: count }, (_, i) => `${LETTERS[i]}. meaning`)
  return `${passage}\n${choices.join('\n')}\n${LETTERS[127]}. none of the above\n[unused0] ${MASK}`
}
