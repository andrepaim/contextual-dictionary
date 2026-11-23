import { describe, expect, test } from 'vitest'
import { CodedError, type ByteSource } from '../../../src/shared/contracts'
import { MODEL_FILES, MODEL_FILE_NAMES, defaultThreads, readModelLoad } from '../../../src/model/load'

const text = (value: string) => new TextEncoder().encode(value)

function source(bytes: Uint8Array, reads: Array<[number, number]> = []): ByteSource {
  return {
    size: bytes.length,
    async read(start, end) { reads.push([start, end]); return bytes.slice(start, end) },
  }
}

function store(files: Record<string, ByteSource | undefined>) {
  const opened: string[] = []
  return { opened, open: async (name: string) => { opened.push(name); return files[name] } }
}

const model = Uint8Array.of(1, 2, 3, 4, 5)
const complete = () => ({
  [MODEL_FILES.model]: source(model),
  [MODEL_FILES.metadata]: source(text('{"template_version":"compact-v1"}')),
  [MODEL_FILES.calibration]: source(text('{"temperature":1}')),
  [MODEL_FILES.tokenizer]: source(text('{"model":"ünïcode"}')),
  [MODEL_FILES.tokenizerConfig]: source(text('{"mask_token":"[MASK]"}')),
})

describe('model file names', () => {
  test('are the stored names the asset manifest uses', () => {
    expect(MODEL_FILES).toEqual({
      model: 'ettin-150m-wsd-int8.onnx', metadata: 'model_metadata.json', calibration: 'calibration.json',
      tokenizer: 'tokenizer.json', tokenizerConfig: 'tokenizer_config.json',
    })
    expect(MODEL_FILE_NAMES).toEqual(Object.values(MODEL_FILES))
  })
})

describe('readModelLoad', () => {
  test('reads every file whole and assembles the load message', async () => {
    const reads: Array<[number, number]> = []
    const files = { ...complete(), [MODEL_FILES.model]: source(model, reads) }
    const { open, opened } = store(files)
    const { message, transfer } = await readModelLoad(open, { threads: 3, wasmBase: 'chrome-extension://id/ort/' })
    expect(new Set(opened)).toEqual(new Set(MODEL_FILE_NAMES))
    expect(reads).toEqual([[0, 5]])
    expect(message).toEqual({
      type: 'load', model: expect.any(ArrayBuffer),
      metadata: '{"template_version":"compact-v1"}', calibration: '{"temperature":1}',
      tokenizer: '{"model":"ünïcode"}', tokenizerConfig: '{"mask_token":"[MASK]"}',
      threads: 3, wasmBase: 'chrome-extension://id/ort/',
    })
    expect(Array.from(new Uint8Array(message.model))).toEqual([1, 2, 3, 4, 5])
    expect(transfer).toEqual([message.model])
  })

  test('transfers the bytes it read without copying them when they fill their buffer', async () => {
    const bytes = Uint8Array.of(9, 9, 9)
    const files = { ...complete(), [MODEL_FILES.model]: { size: 3, read: async () => bytes } }
    const { message } = await readModelLoad(store(files).open, { threads: 1, wasmBase: '/ort/' })
    expect(message.model).toBe(bytes.buffer)
  })

  test('copies bytes that are a view into a larger buffer, so only the model is transferred', async () => {
    const backing = Uint8Array.of(0, 7, 7, 7, 0)
    const files = { ...complete(), [MODEL_FILES.model]: { size: 3, read: async () => backing.subarray(1, 4) } }
    const { message } = await readModelLoad(store(files).open, { threads: 1, wasmBase: '/ort/' })
    expect(message.model).not.toBe(backing.buffer)
    expect(Array.from(new Uint8Array(message.model))).toEqual([7, 7, 7])
  })

  test('fails with MODEL_MISSING naming the missing file', async () => {
    const files = { ...complete(), [MODEL_FILES.tokenizer]: undefined }
    const error = await readModelLoad(store(files).open, { threads: 1, wasmBase: '/ort/' }).catch(caught => caught)
    expect(error).toBeInstanceOf(CodedError)
    expect(error.code).toBe('MODEL_MISSING')
    expect(error.details).toEqual({ file: MODEL_FILES.tokenizer })
  })

  test('fails with LOAD_FAILED when a file reads short', async () => {
    const files = { ...complete(), [MODEL_FILES.model]: { size: 5, read: async () => Uint8Array.of(1) } }
    const error = await readModelLoad(store(files).open, { threads: 1, wasmBase: '/ort/' }).catch(caught => caught)
    expect(error).toMatchObject({ code: 'LOAD_FAILED', details: { file: MODEL_FILES.model } })
  })

  test('passes on a coded error from the store and codes any other error LOAD_FAILED', async () => {
    const coded = { ...complete(), [MODEL_FILES.metadata]: { size: 1, read: async () => { throw new CodedError('ASSET_CORRUPT') } } }
    expect(await readModelLoad(store(coded).open, { threads: 1, wasmBase: '/ort/' }).catch(caught => caught.code)).toBe('ASSET_CORRUPT')
    const plain = { ...complete(), [MODEL_FILES.metadata]: { size: 1, read: async () => { throw new Error('io') } } }
    expect(await readModelLoad(store(plain).open, { threads: 1, wasmBase: '/ort/' }).catch(caught => caught.code)).toBe('LOAD_FAILED')
    const opening = await readModelLoad(async () => { throw new Error('opfs') }, { threads: 1, wasmBase: '/ort/' }).catch(caught => caught.code)
    expect(opening).toBe('LOAD_FAILED')
  })
})

describe('defaultThreads', () => {
  test.each([
    [1, 1], [2, 1], [3, 1], [4, 2], [8, 4], [12, 6], [16, 8], [24, 8], [64, 8],
    [0, 1], [Number.NaN, 1], [-4, 1],
  ])('with %s logical cores uses %s threads', (cores, threads) => {
    expect(defaultThreads(cores)).toBe(threads)
  })

  test('reads the browser\'s core count by default', () => {
    const cores = globalThis.navigator?.hardwareConcurrency
    expect(defaultThreads()).toBe(defaultThreads(cores))
  })
})
