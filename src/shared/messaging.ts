// Replies over chrome.runtime messaging, shared by the service worker and the
// offscreen document.
import { CodedError, type Reply } from './contracts'

/** A failed Reply for `error`. Only a CodedError's text is kept: other errors may quote page text. */
export function errorReply(error: unknown): Reply<never> {
  if (error instanceof CodedError) {
    return error.details ? { ok: false, code: error.code, message: error.message, details: error.details } : { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The value of a successful Reply; throws the CodedError of a failed one, NO_RESPONSE for anything else. */
export function unwrapReply(reply: unknown): unknown {
  if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new CodedError('NO_RESPONSE', 'No answer from the extension.')
  if (reply.ok) return reply.value
  const code = typeof reply.code === 'string' && reply.code ? reply.code : 'INTERNAL_ERROR'
  throw new CodedError(code, typeof reply.message === 'string' && reply.message ? reply.message : code, isRecord(reply.details) ? reply.details : undefined)
}

/** The parts of chrome.runtime.MessageSender the handlers look at. */
export interface SenderLike { id?: string; url?: string; tab?: unknown }

export type Handler = (message: unknown, sender: SenderLike) => Promise<unknown> | undefined

/**
 * A chrome.runtime.onMessage listener over `handle`. A handler that returns
 * undefined leaves the message to other listeners; otherwise the answer is
 * sent when it is ready.
 */
export function messageListener(handle: Handler) {
  return (message: unknown, sender: SenderLike, sendResponse: (response: unknown) => void): boolean => {
    const answer = handle(message, sender)
    if (!answer) return false
    const send = (response: unknown) => { try { sendResponse(response) } catch { /* the asking page went away */ } }
    answer.then(send, error => send(errorReply(error)))
    return true
  }
}
