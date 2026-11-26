import { beforeEach, describe, expect, test } from 'vitest'
import { CodedError } from '../../../src/shared/contracts'
import { LOGIT_COUNT, MODEL_REVISION, TEMPLATE_VERSION, createSenseSession } from '../../../src/model/session'
import { CLS_ID, FakeTensor, FakeTokenizer, MASK_ID, OLD_REVISION, REVISION, SEP_ID, calibration, fakeRuntime, loadInput, metadata, prompt, sequence, tokenizerConfig, tokenizerJson } from './fakes'

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise } catch (error) { return error instanceof CodedError ? error.code : `not coded: ${String(error)}` }
  return 'resolved'
}

beforeEach(() => { FakeTokenizer.instances = [] })

describe('createSenseSession', () => {
  test('pins the checkpoint the extension was built for', () => {
    expect(MODEL_REVISION).toBe(REVISION)
    expect(TEMPLATE_VERSION).toBe('compact-v1')
    expect(LOGIT_COUNT).toBe(128)
  })

  test('creates a WebAssembly session from the model bytes with the requested threads and runtime directory', async () => {
    const runtime = fakeRuntime()
    const input = loadInput({ threads: 6, wasmBase: 'chrome-extension://abc/ort/' })
    await createSenseSession(input, async () => runtime)
    expect(runtime.ort.calls.create).toHaveLength(1)
    const [{ model, options, wasm }] = runtime.ort.calls.create as [typeof runtime.ort.calls.create[0]]
    expect(Array.from(model)).toEqual([8, 6, 4, 9])
    expect(options).toEqual({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    expect(wasm).toMatchObject({ numThreads: 6, wasmPaths: 'chrome-extension://abc/ort/' })
  })

  test('builds the prompt format from the metadata, the calibration and the tokenizer config', async () => {
    const session = await createSenseSession(loadInput(), async () => fakeRuntime())
    expect(session.format).toEqual({
      letters: expect.any(Array), nota_index: 127, none_text: 'none of the above', separator: '[unused0]',
      mask_token: '[MASK]', max_length: 32, temperature: 1.5,
    })
    expect(session.format.letters).toHaveLength(128)
    const [tokenizer] = FakeTokenizer.instances
    expect(tokenizer?.json).toEqual(JSON.parse(tokenizerJson()))
    expect(tokenizer?.config).toEqual(JSON.parse(tokenizerConfig()))
  })

  test('uses temperature 1 when the calibration has none', async () => {
    const session = await createSenseSession(loadInput({ calibration: '{}' }), async () => fakeRuntime())
    expect(session.format.temperature).toBe(1)
  })

  test.each([
    ['another template', { metadata: metadata({ template_version: 'compact-v2' }) }],
    ['another revision', { metadata: metadata({ model_revision: 'f'.repeat(40) }) }],
    ['too few letters', { metadata: metadata({ letters: ['A', 'B'] }) }],
    ['no "none of the above" inside the first 128 outputs', { metadata: metadata({ nota_index: 128, letters: [...Array(129).keys()].map(String) }) }],
    ['letters that are not text', { metadata: metadata({ letters: [1, 2, 3] }) }],
    ['a missing separator', { metadata: metadata({ separator: undefined }) }],
    ['no token limit', { metadata: metadata({ max_length: 0 }) }],
    ['the metadata of the checkpoint assets-v1 shipped', { metadata: metadata({ model_revision: OLD_REVISION }) }],
    ['metadata that is not JSON', { metadata: '{' }],
    ['metadata that is not an object', { metadata: '[]' }],
    ['a calibration that is not JSON', { calibration: 'x' }],
    ['an unusable temperature', { calibration: calibration('hot') }],
    ['a non-positive temperature', { calibration: calibration(0) }],
    ['a tokenizer config without a mask token', { tokenizerConfig: tokenizerConfig({ mask_token: undefined }) }],
    ['a tokenizer config that is not JSON', { tokenizerConfig: '' }],
    ['a tokenizer that is not JSON', { tokenizer: '{"' }],
    ['a tokenizer the library refuses', { tokenizer: tokenizerJson({ broken: true }) }],
    ['a tokenizer without the mask token', { tokenizer: tokenizerJson({ noMask: true }) }],
  ])('refuses %s with MODEL_MISMATCH and creates no session', async (_, overrides) => {
    const runtime = fakeRuntime()
    expect(await codeOf(createSenseSession(loadInput(overrides), async () => runtime))).toBe('MODEL_MISMATCH')
    expect(runtime.ort.calls.create).toHaveLength(0)
  })

  test('checks the metadata before it loads the runtime', async () => {
    let loaded = false
    const code = await codeOf(createSenseSession(loadInput({ metadata: metadata({ template_version: 'x' }) }), async () => { loaded = true; return fakeRuntime() }))
    expect(code).toBe('MODEL_MISMATCH')
    expect(loaded).toBe(false)
  })

  test('reports RUNTIME_FAILED when the runtime cannot be loaded or configured', async () => {
    expect(await codeOf(createSenseSession(loadInput(), async () => { throw new Error('import failed') }))).toBe('RUNTIME_FAILED')
    const runtime = fakeRuntime()
    Object.defineProperty(runtime.ort.env, 'wasm', { get() { throw new Error('no wasm') } })
    expect(await codeOf(createSenseSession(loadInput(), async () => runtime))).toBe('RUNTIME_FAILED')
  })

  test('reports SESSION_FAILED when ONNX Runtime refuses the model', async () => {
    const runtime = fakeRuntime({ createError: new Error('protobuf parsing failed') })
    expect(await codeOf(createSenseSession(loadInput(), async () => runtime))).toBe('SESSION_FAILED')
  })

  test('reports LOAD_FAILED for anything else', async () => {
    const runtime = fakeRuntime()
    Object.defineProperty(runtime.tokenizers, 'Tokenizer', { get() { throw new Error('unexpected') } })
    expect(await codeOf(createSenseSession(loadInput(), async () => runtime))).toBe('LOAD_FAILED')
  })
})

describe('logits', () => {
  test('feeds the token ids, an all-ones attention mask and the single mask position as int64 tensors', async () => {
    const runtime = fakeRuntime()
    const session = await createSenseSession(loadInput(), async () => runtime)
    const text = prompt(2)
    const ids = new FakeTokenizer({}, {}).encode(text).ids
    await session.logits(text)
    const [feeds] = runtime.ort.calls.run as [Record<string, FakeTensor>]
    expect(Object.keys(feeds).sort()).toEqual(['attention_mask', 'input_ids', 'prediction_positions'])
    for (const tensor of Object.values(feeds)) {
      expect(tensor).toBeInstanceOf(FakeTensor)
      expect(tensor.type).toBe('int64')
      expect(tensor.data).toBeInstanceOf(BigInt64Array)
    }
    expect(Array.from(feeds.input_ids!.data, Number)).toEqual(ids)
    expect(ids[0]).toBe(CLS_ID)
    expect(ids.at(-1)).toBe(SEP_ID)
    expect(feeds.input_ids!.dims).toEqual([1, ids.length])
    expect(Array.from(feeds.attention_mask!.data, Number)).toEqual(ids.map(() => 1))
    expect(feeds.attention_mask!.dims).toEqual([1, ids.length])
    expect(Array.from(feeds.prediction_positions!.data, Number)).toEqual([ids.indexOf(MASK_ID)])
    expect(ids.indexOf(MASK_ID)).toBe(ids.length - 2)
    expect(feeds.prediction_positions!.dims).toEqual([1])
  })

  test('answers a copy of the first 128 logits and frees the output tensor', async () => {
    const output = sequence(200)
    const runtime = fakeRuntime({ logits: () => ({ data: output, dims: [1, 200] }) })
    const session = await createSenseSession(loadInput(), async () => runtime)
    const answer = await session.logits(prompt(3))
    expect(answer).toBeInstanceOf(Float32Array)
    const logits = answer as Float32Array
    expect(logits).toHaveLength(128)
    expect(Array.from(logits)).toEqual(Array.from(output.subarray(0, 128)))
    expect(logits.buffer).not.toBe(output.buffer)
    expect(logits.byteOffset).toBe(0)
    expect(logits.buffer.byteLength).toBe(128 * 4)
    expect(runtime.ort.calls.disposed).toBe(1)
  })

  test('accepts exactly 128 outputs and exactly max_length tokens', async () => {
    const runtime = fakeRuntime({ logits: () => ({ data: sequence(128), dims: [1, 128] }) })
    const session = await createSenseSession(loadInput(), async () => runtime)
    const text = prompt(8)
    expect(new FakeTokenizer({}, {}).encode(text).ids).toHaveLength(32)
    expect(await session.logits(text)).toBeInstanceOf(Float32Array)
  })

  test('refuses a prompt longer than max_length tokens with TOO_LONG, without running', async () => {
    const runtime = fakeRuntime()
    const session = await createSenseSession(loadInput(), async () => runtime)
    expect(await session.logits(prompt(9))).toBe('TOO_LONG')
    expect(runtime.ort.calls.run).toHaveLength(0)
  })

  test.each([
    ['no mask', 'Drag the *mouse* L0. a device [unused0]'],
    ['two masks', 'Drag the [MASK] L0. a device [unused0] [MASK]'],
  ])('refuses a prompt with %s with MASK, without running', async (_, text) => {
    const runtime = fakeRuntime()
    const session = await createSenseSession(loadInput(), async () => runtime)
    expect(await session.logits(text)).toBe('MASK')
    expect(runtime.ort.calls.run).toHaveLength(0)
  })

  test.each([
    ['fewer than 128 outputs', { logits: () => ({ data: sequence(127), dims: [1, 127] }) }],
    ['no logits output', { logits: () => undefined }],
    ['a failed run', { runError: () => new Error('run failed') }],
  ])('answers RUN_FAILED for %s', async (_, options) => {
    const session = await createSenseSession(loadInput(), async () => fakeRuntime(options))
    expect(await session.logits(prompt(2))).toBe('RUN_FAILED')
  })

  test('answers RUN_FAILED when the tokenizer throws', async () => {
    const session = await createSenseSession(loadInput(), async () => fakeRuntime())
    expect(await session.logits('THROW [MASK]')).toBe('RUN_FAILED')
  })

  test('keeps working after a failed run', async () => {
    const session = await createSenseSession(loadInput(), async () => fakeRuntime({ runError: call => call === 1 ? new Error('once') : undefined }))
    expect(await session.logits(prompt(2))).toBe('RUN_FAILED')
    expect(await session.logits(prompt(2))).toBeInstanceOf(Float32Array)
  })

  test('release frees the ONNX session', async () => {
    const runtime = fakeRuntime()
    const session = await createSenseSession(loadInput(), async () => runtime)
    await session.release()
    expect(runtime.ort.calls.released).toBe(1)
  })
})
