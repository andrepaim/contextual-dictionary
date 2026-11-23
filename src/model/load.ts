// Assembles the model worker's load message from the installed files.
import { CodedError, type ByteSource, type ModelLoad } from '../shared/contracts'

/** The names the model files are stored under, shared with the asset manifest. */
export const MODEL_FILES = {
  model: 'ettin-150m-wsd-int8.onnx',
  metadata: 'model_metadata.json',
  calibration: 'calibration.json',
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
} as const

export const MODEL_FILE_NAMES: readonly string[] = Object.values(MODEL_FILES)

export type OpenFile = (storedName: string) => Promise<ByteSource | undefined>

async function readWhole(open: OpenFile, name: string): Promise<Uint8Array> {
  let bytes: Uint8Array, size: number
  try {
    const source = await open(name)
    if (!source) throw new CodedError('MODEL_MISSING', `${name} is not installed`, { file: name })
    size = source.size
    bytes = await source.read(0, size)
  } catch (error) {
    throw error instanceof CodedError ? error : new CodedError('LOAD_FAILED', `${name} could not be read`, { file: name })
  }
  if (bytes.byteLength !== size) throw new CodedError('LOAD_FAILED', `${name} read short`, { file: name })
  return bytes
}

/** An ArrayBuffer holding exactly `bytes`, reusing their buffer when they fill it. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer
  return bytes.slice().buffer as ArrayBuffer
}

/**
 * Reads the five model files and builds the `load` message. Post it with
 * `transfer`, so the model bytes move to the worker instead of being copied.
 * Rejects with a CodedError: MODEL_MISSING, LOAD_FAILED, or the store's own code.
 */
export async function readModelLoad(open: OpenFile, options: { threads: number; wasmBase: string }): Promise<{ message: ModelLoad; transfer: Transferable[] }> {
  const decoder = new TextDecoder()
  const text = async (name: string) => decoder.decode(await readWhole(open, name))
  const [model, metadata, calibration, tokenizer, tokenizerConfig] = await Promise.all([
    readWhole(open, MODEL_FILES.model).then(ownBuffer),
    text(MODEL_FILES.metadata),
    text(MODEL_FILES.calibration),
    text(MODEL_FILES.tokenizer),
    text(MODEL_FILES.tokenizerConfig),
  ])
  const message: ModelLoad = { type: 'load', model, metadata, calibration, tokenizer, tokenizerConfig, threads: options.threads, wasmBase: options.wasmBase }
  return { message, transfer: [model] }
}

/** Half the logical cores, at least 1 and at most 8. */
export function defaultThreads(cores: number | undefined = globalThis.navigator?.hardwareConcurrency): number {
  if (typeof cores !== 'number' || !Number.isFinite(cores)) return 1
  return Math.max(1, Math.min(8, Math.floor(cores / 2)))
}
