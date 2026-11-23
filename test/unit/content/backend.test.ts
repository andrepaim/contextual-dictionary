import { describe, expect, test, vi } from 'vitest'
import { BACKEND_ERRORS, createBackend } from '../../../src/content/backend'
import { CodedError } from '../../../src/shared/contracts'

const define = { type: 'define', requestId: 'r1', selection: { text: 'mouse', before: '', after: '' } } as const

async function failure(promise: Promise<unknown>): Promise<CodedError> {
  try { await promise } catch (error) { return error as CodedError }
  throw new Error('expected a rejection')
}

describe('createBackend', () => {
  test('sends the request and returns the value of a successful reply', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, value: null }))
    const backend = createBackend(sendMessage)
    await expect(backend.send({ type: 'cancel-define', requestId: 'r1' })).resolves.toBeNull()
    expect(sendMessage).toHaveBeenCalledWith({ type: 'cancel-define', requestId: 'r1' })
  })

  test('turns a failed reply into a CodedError with its code, message and details', async () => {
    const backend = createBackend(async () => ({ ok: false, code: 'DOWNLOAD_SIZE_CHANGED', message: 'size changed', details: { requiredBytes: 5 } }))
    const error = await failure(backend.send({ type: 'download', bundle: 'model', acceptBytes: 4 }))
    expect(error).toBeInstanceOf(CodedError)
    expect(error.code).toBe('DOWNLOAD_SIZE_CHANGED')
    expect(error.message).toBe('size changed')
    expect(error.details).toEqual({ requiredBytes: 5 })
  })

  test('a missing or malformed reply is NO_RESPONSE, a failure without a code BACKEND_ERROR', async () => {
    for (const reply of [undefined, null, 'text', { ok: 'yes' }]) {
      const error = await failure(createBackend(async () => reply).send({ type: 'status' }))
      expect(error.code, JSON.stringify(reply)).toBe(BACKEND_ERRORS.noResponse)
    }
    expect((await failure(createBackend(async () => ({ ok: false })).send({ type: 'status' }))).code).toBe('BACKEND_ERROR')
  })

  test('an invalidated extension context is reported quietly, thrown or rejected', async () => {
    const errors = vi.spyOn(console, 'error')
    const thrown = createBackend(() => { throw new Error('Extension context invalidated.') })
    expect((await failure(thrown.send({ type: 'status' }))).code).toBe(BACKEND_ERRORS.invalidated)
    const rejected = createBackend(async () => { throw new Error('Extension context invalidated.') })
    expect((await failure(rejected.send({ type: 'status' }))).code).toBe(BACKEND_ERRORS.invalidated)
    expect(errors).not.toHaveBeenCalled()
  })

  test('no receiver and other transport failures are NO_RESPONSE', async () => {
    const none = createBackend(async () => { throw new Error('Could not establish connection. Receiving end does not exist.') })
    expect((await failure(none.send({ type: 'status' }))).code).toBe(BACKEND_ERRORS.noResponse)
    const odd = createBackend(async () => { throw 'strange' })
    expect((await failure(odd.send({ type: 'status' }))).code).toBe(BACKEND_ERRORS.noResponse)
  })

  test('an abort rejects at once with ABORTED and ignores the later reply', async () => {
    let reply!: (value: unknown) => void
    const backend = createBackend(() => new Promise(resolve => { reply = resolve }))
    const controller = new AbortController()
    const pending = backend.send(define, controller.signal)
    controller.abort()
    expect((await failure(pending)).code).toBe(BACKEND_ERRORS.aborted)
    reply({ ok: true, value: {} })
  })

  test('an already aborted signal sends nothing', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, value: null }))
    const controller = new AbortController()
    controller.abort()
    expect((await failure(createBackend(sendMessage).send(define, controller.signal))).code).toBe(BACKEND_ERRORS.aborted)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('a reply before the abort removes the abort listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await createBackend(async () => ({ ok: true, value: 1 })).send({ type: 'status' }, controller.signal)
    expect(remove).toHaveBeenCalled()
  })
})
