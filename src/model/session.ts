// The word-sense model session: verifies the checkpoint's metadata, creates
// an ONNX Runtime WebAssembly session from the model bytes, and turns a
// finished compact-v1 prompt into the model's first 128 answer logits.
//
// ONNX Runtime and the tokenizer library are passed in, so tests use fakes and
// the worker decides how they are imported. Ported from pdfpal's
// src/core/sense-worker.ts.
import { CodedError, type ModelLoad, type SenseFormat } from '../shared/contracts'

/** The checkpoint this extension is built for (sign/Ettin-150m-WSD, dynamic INT8 export). */
export const MODEL_REVISION = '8751b577199d1bb95b74fa2457da7065d57100ae'
export const TEMPLATE_VERSION = 'compact-v1'
/** The model answers one logit per letter; the first 128 are the choices. */
export const LOGIT_COUNT = 128

/** Load failures. */
export type LoadCode = 'MODEL_MISMATCH' | 'RUNTIME_FAILED' | 'SESSION_FAILED' | 'LOAD_FAILED'
/** Why a prompt was not scored. */
export type ScoreCode = 'TOO_LONG' | 'MASK' | 'RUN_FAILED'

export interface OrtOutput { readonly data: unknown; readonly dims: readonly number[]; dispose?(): void }
export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Readonly<Record<string, OrtOutput | undefined>>>
  release(): Promise<void>
}
/** The part of `onnxruntime-web` the session uses. */
export interface OrtLike {
  env: { wasm: { numThreads?: number; wasmPaths?: unknown } }
  InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel: 'all' }): Promise<OrtSessionLike> }
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown
}
export interface TokenizerLike {
  encode(text: string): { ids: number[] }
  token_to_id(token: string): number | undefined
}
/** The part of `@huggingface/tokenizers` the session uses. */
export interface TokenizerModuleLike { Tokenizer: new (tokenizer: object, config: object) => TokenizerLike }
export interface SenseRuntime { ort: OrtLike; tokenizers: TokenizerModuleLike }

export type SessionInput = Omit<ModelLoad, 'type'>

export interface SenseSession {
  readonly format: SenseFormat
  /** The first 128 logits for a prompt, or why it was not scored. Never throws. */
  logits(prompt: string): Promise<Float32Array | ScoreCode>
  release(): Promise<void>
}

const fail = (code: LoadCode, message: string = code): never => { throw new CodedError(code, message) }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function parseObject(text: string, name: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('MODEL_MISMATCH', `${name} is not JSON`) }
  return isRecord(value) ? value : fail('MODEL_MISMATCH', `${name} is not an object`)
}

/** The prompt format from verified metadata; throws MODEL_MISMATCH for another checkpoint. */
function readFormat(input: SessionInput): SenseFormat {
  const metadata = parseObject(input.metadata, 'model_metadata.json')
  const calibration = parseObject(input.calibration, 'calibration.json')
  const config = parseObject(input.tokenizerConfig, 'tokenizer_config.json')
  if (metadata.template_version !== TEMPLATE_VERSION) fail('MODEL_MISMATCH', 'unsupported prompt template')
  if (metadata.model_revision !== MODEL_REVISION) fail('MODEL_MISMATCH', 'unexpected model revision')
  const { letters, nota_index: nota, none_text: none, separator, max_length: maxLength } = metadata
  if (!Array.isArray(letters) || !letters.every(isText)) return fail('MODEL_MISMATCH', 'letters')
  if (!Number.isSafeInteger(nota) || (nota as number) < 0 || (nota as number) >= LOGIT_COUNT || letters.length <= (nota as number)) return fail('MODEL_MISMATCH', 'nota_index')
  if (!isText(none) || !isText(separator)) return fail('MODEL_MISMATCH', 'none_text or separator')
  if (!Number.isSafeInteger(maxLength) || (maxLength as number) < 1) return fail('MODEL_MISMATCH', 'max_length')
  const temperature = calibration.temperature ?? 1
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature <= 0) return fail('MODEL_MISMATCH', 'temperature')
  if (!isText(config.mask_token)) return fail('MODEL_MISMATCH', 'mask_token')
  return {
    letters: letters as string[], nota_index: nota as number, none_text: none, separator,
    mask_token: config.mask_token, max_length: maxLength as number, temperature,
  }
}

/**
 * Verifies the metadata, loads the runtime, builds the tokenizer and creates
 * the session. Throws a CodedError with a LoadCode.
 */
export async function createSenseSession(input: SessionInput, runtime: () => Promise<SenseRuntime>): Promise<SenseSession> {
  try {
    const format = readFormat(input)
    const tokenizerJson = parseObject(input.tokenizer, 'tokenizer.json')
    const tokenizerConfig = parseObject(input.tokenizerConfig, 'tokenizer_config.json')
    let ort: OrtLike, tokenizers: TokenizerModuleLike
    try {
      ({ ort, tokenizers } = await runtime())
      ort.env.wasm.numThreads = input.threads
      ort.env.wasm.wasmPaths = input.wasmBase
    } catch { return fail('RUNTIME_FAILED') }
    const Tokenizer = tokenizers.Tokenizer
    let tokenizer: TokenizerLike
    try { tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig) } catch { return fail('MODEL_MISMATCH', 'tokenizer') }
    const mask = tokenizer.token_to_id(format.mask_token)
    if (mask === undefined) fail('MODEL_MISMATCH', 'mask token missing from the vocabulary')
    let session: OrtSessionLike
    try {
      session = await ort.InferenceSession.create(new Uint8Array(input.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    } catch { return fail('SESSION_FAILED') }
    return new OnnxSenseSession(ort, tokenizer, mask!, session, format)
  } catch (error) {
    throw error instanceof CodedError ? error : new CodedError('LOAD_FAILED')
  }
}

class OnnxSenseSession implements SenseSession {
  constructor(
    private readonly ort: OrtLike,
    private readonly tokenizer: TokenizerLike,
    private readonly mask: number,
    private readonly session: OrtSessionLike,
    readonly format: SenseFormat,
  ) {}

  async logits(prompt: string): Promise<Float32Array | ScoreCode> {
    try {
      const ids = this.tokenizer.encode(prompt).ids
      if (ids.length > this.format.max_length) return 'TOO_LONG'
      const positions = ids.flatMap((id, i) => id === this.mask ? [i] : [])
      if (positions.length !== 1) return 'MASK'
      const { Tensor } = this.ort
      const output = await this.session.run({
        input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        attention_mask: new Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
        prediction_positions: new Tensor('int64', BigInt64Array.of(BigInt(positions[0]!)), [1]),
      })
      const result = output.logits
      const data = result?.data as ArrayLike<number> | undefined
      if (!data || typeof data.length !== 'number' || data.length < LOGIT_COUNT) return 'RUN_FAILED'
      const logits = new Float32Array(LOGIT_COUNT)
      for (let i = 0; i < LOGIT_COUNT; i++) logits[i] = data[i]!
      result!.dispose?.()
      return logits
    } catch {
      return 'RUN_FAILED'
    }
  }

  release(): Promise<void> { return this.session.release() }
}
