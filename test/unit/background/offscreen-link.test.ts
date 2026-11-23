import { describe, expect, test, vi } from 'vitest'
import { OffscreenLink, type OffscreenApi } from '../../../src/background/offscreen-link'
import { DEFAULT_SETTINGS } from '../../../src/shared/contracts'
import { OFFSCREEN_TARGET, type OffscreenMessage } from '../../../src/shared/offscreen-protocol'

/** The offscreen API and channel: one document that answers with `answer`. */
class FakeApi implements OffscreenApi {
  exists = false
  /** Set once the document's script listens; messages before that find no receiver. */
  listening = false
  created = 0
  sent: OffscreenMessage[] = []
  answer: (message: OffscreenMessage) => unknown = message => ({ ok: true, value: message.request.type })
  createDelayMs = 0
  listenDelayMs = 0
  createError: Error | undefined

  async hasDocument() { return this.exists }
  async createDocument() {
    await new Promise(resolve => setTimeout(resolve, this.createDelayMs))
    if (this.createError) throw this.createError
    if (this.exists) throw new Error('Only a single offscreen document may be created.')
    this.exists = true
    this.created++
    setTimeout(() => { this.listening = true }, this.listenDelayMs)
  }
  async sendMessage(message: OffscreenMessage) {
    this.sent.push(message)
    if (!this.exists || !this.listening) throw new Error('Could not establish connection. Receiving end does not exist.')
    return this.answer(message)
  }
  close() { this.exists = false; this.listening = false }
}

const options = { retries: 5, retryDelayMs: 1 }

describe('OffscreenLink', () => {
  test('creates the document on first need and sends the request with the settings', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
    expect(api.created).toBe(1)
    expect(api.sent.at(-1)).toEqual({ target: OFFSCREEN_TARGET, request: { type: 'status' }, settings: DEFAULT_SETTINGS })
    await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })
    expect(api.created).toBe(1)
  })

  test('without create, a missing document is not created and nothing is sent', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    expect(await link.call({ type: 'cancel-define', requestId: 'a' }, DEFAULT_SETTINGS, { create: false })).toBeUndefined()
    expect(api.created).toBe(0)
    expect(api.sent).toEqual([])
    expect(await link.exists()).toBe(false)
  })

  test('without create, an existing document still gets the message', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    await link.ensure()
    await vi.waitFor(() => expect(api.listening).toBe(true))
    expect(await link.call({ type: 'settings' }, DEFAULT_SETTINGS, { create: false })).toBe('settings')
    expect(await link.exists()).toBe(true)
  })

  test('concurrent first requests create one document', async () => {
    const api = new FakeApi()
    api.createDelayMs = 5
    const link = new OffscreenLink(api, options)
    const answers = await Promise.all([1, 2, 3].map(() => link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })))
    expect(answers).toEqual(['status', 'status', 'status'])
    expect(api.created).toBe(1)
  })

  test('waits for a new document to start listening', async () => {
    const api = new FakeApi()
    api.listenDelayMs = 3
    const link = new OffscreenLink(api, { retries: 50, retryDelayMs: 1 })
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
  })

  test('recreates a document that was closed or crashed', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })
    api.close()
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
    expect(api.created).toBe(2)
  })

  test('recreates a document that disappears between the check and the send', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })
    const send = api.sendMessage.bind(api)
    api.sendMessage = async message => { api.sendMessage = send; api.close(); return send(message) }
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
    expect(api.created).toBe(2)
  })

  test('"already exists" from a create that raced another context is not an error', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    api.hasDocument = async () => false
    api.exists = true
    api.listening = true
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
  })

  test('a document that never answers ends in OFFSCREEN_UNAVAILABLE', async () => {
    const api = new FakeApi()
    api.listenDelayMs = 10_000
    const link = new OffscreenLink(api, options)
    await expect(link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).rejects.toMatchObject({ code: 'OFFSCREEN_UNAVAILABLE' })
    expect(api.sent).toHaveLength(options.retries + 1)
  })

  test('a failed create ends in OFFSCREEN_UNAVAILABLE and a later call tries again', async () => {
    const api = new FakeApi()
    api.createError = new Error('not allowed')
    const link = new OffscreenLink(api, options)
    await expect(link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).rejects.toMatchObject({ code: 'OFFSCREEN_UNAVAILABLE' })
    api.createError = undefined
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('status')
  })

  test('an empty answer (the document closed while answering) is retried', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    let calls = 0
    api.answer = () => (++calls === 1 ? undefined : { ok: true, value: 'second' })
    expect(await link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).toBe('second')
  })

  test('an error reply is thrown as its coded error, not retried', async () => {
    const api = new FakeApi()
    api.answer = () => ({ ok: false, code: 'DICTIONARY_MISSING', message: 'none' })
    const link = new OffscreenLink(api, options)
    await link.ensure()
    await vi.waitFor(() => expect(api.listening).toBe(true))
    await expect(link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).rejects.toMatchObject({ code: 'DICTIONARY_MISSING' })
    expect(api.sent).toHaveLength(1)
  })

  test('other send errors are not retried', async () => {
    const api = new FakeApi()
    const link = new OffscreenLink(api, options)
    await link.ensure()
    api.listening = true
    api.sendMessage = async () => { throw new Error('Extension context invalidated.') }
    await expect(link.call({ type: 'status' }, DEFAULT_SETTINGS, { create: true })).rejects.toMatchObject({ code: 'OFFSCREEN_UNAVAILABLE' })
  })
})
