import { describe, expect, test, vi } from 'vitest'
import { CodedError } from '../../../src/shared/contracts'
import { errorReply, messageListener, unwrapReply } from '../../../src/shared/messaging'

describe('errorReply', () => {
  test('keeps the code, message and details of a CodedError', () => {
    expect(errorReply(new CodedError('DICTIONARY_MISSING', 'No dictionary', { a: 1 }))).toEqual({ ok: false, code: 'DICTIONARY_MISSING', message: 'No dictionary', details: { a: 1 } })
    expect(errorReply(new CodedError('X'))).toEqual({ ok: false, code: 'X', message: 'X' })
  })
  test('anything else is INTERNAL_ERROR without its text, which may hold page content', () => {
    expect(errorReply(new Error('secret page text'))).toEqual({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' })
    expect(errorReply('boom')).toEqual({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' })
  })
})

describe('unwrapReply', () => {
  test('returns the value of a successful reply', () => {
    expect(unwrapReply({ ok: true, value: 5 })).toBe(5)
    expect(unwrapReply({ ok: true, value: null })).toBeNull()
  })
  test('throws the coded error of a failed reply', () => {
    expect(() => unwrapReply({ ok: false, code: 'NOPE', message: 'No', details: { b: 2 } })).toThrow(expect.objectContaining({ code: 'NOPE', message: 'No', details: { b: 2 } }))
  })
  test('throws NO_RESPONSE for anything that is not a reply', () => {
    for (const value of [undefined, null, 5, {}, { ok: 'yes' }]) expect(() => unwrapReply(value)).toThrow(expect.objectContaining({ code: 'NO_RESPONSE' }))
    expect(() => unwrapReply({ ok: false })).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
  })
})

describe('messageListener', () => {
  test('answers asynchronously with the handler reply and keeps the channel open', async () => {
    const listener = messageListener(async message => ({ ok: true, value: message }))
    const sendResponse = vi.fn()
    expect(listener('hi', {}, sendResponse)).toBe(true)
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, value: 'hi' }))
  })
  test('does not answer messages the handler does not take', () => {
    const sendResponse = vi.fn()
    expect(messageListener(() => undefined)('hi', {}, sendResponse)).toBe(false)
    expect(sendResponse).not.toHaveBeenCalled()
  })
  test('a handler that rejects answers with an error reply', async () => {
    const sendResponse = vi.fn()
    messageListener(() => Promise.reject(new CodedError('BROKEN')))('hi', {}, sendResponse)
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, code: 'BROKEN', message: 'BROKEN' }))
  })
  test('a closed channel (the page went away) is ignored', async () => {
    const sendResponse = vi.fn(() => { throw new Error('port closed') })
    messageListener(async () => ({ ok: true, value: 1 }))('hi', {}, sendResponse)
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled())
  })
})
