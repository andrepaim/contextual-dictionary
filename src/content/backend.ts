// The Backend over the extension's message channel. The content script and the
// popup pass chrome.runtime.sendMessage; tests pass a fake.
import { CodedError, type Answers, type Backend, type Request } from '../shared/contracts'

/** Codes this module adds to the back end's own. */
export const BACKEND_ERRORS = {
  /** The caller aborted the request. */
  aborted: 'ABORTED',
  /** The extension was reloaded or removed; this page's script is orphaned. */
  invalidated: 'CONTEXT_INVALIDATED',
  /** Nothing answered, or the answer was not a Reply. */
  noResponse: 'NO_RESPONSE',
} as const

export type SendMessage = (message: Request) => Promise<unknown> | unknown

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function transportError(error: unknown): CodedError {
  const message = error instanceof Error ? error.message : String(error)
  // Chrome's wording when the extension was updated or removed under a page.
  if (/context invalidated/i.test(message)) return new CodedError(BACKEND_ERRORS.invalidated)
  return new CodedError(BACKEND_ERRORS.noResponse)
}

function unwrap(reply: unknown): unknown {
  if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new CodedError(BACKEND_ERRORS.noResponse)
  if (reply.ok) return reply.value
  const code = typeof reply.code === 'string' && reply.code ? reply.code : 'BACKEND_ERROR'
  const message = typeof reply.message === 'string' && reply.message ? reply.message : code
  throw new CodedError(code, message, isRecord(reply.details) ? reply.details : undefined)
}

/** A Backend that sends each request with `sendMessage` and unwraps the Reply. */
export function createBackend(sendMessage: SendMessage): Backend {
  return {
    send<T extends Request>(request: T, signal?: AbortSignal): Promise<Answers[T['type']]> {
      if (signal?.aborted) return Promise.reject(new CodedError(BACKEND_ERRORS.aborted))
      let sent: Promise<unknown>
      try { sent = Promise.resolve(sendMessage(request)) } catch (error) { sent = Promise.reject(error) }
      const answer = sent.then(unwrap, error => { throw transportError(error) }) as Promise<Answers[T['type']]>
      if (!signal) return answer
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new CodedError(BACKEND_ERRORS.aborted))
        signal.addEventListener('abort', onAbort, { once: true })
        const settle = <V>(finish: (value: V) => void) => (value: V) => { signal.removeEventListener('abort', onAbort); finish(value) }
        answer.then(settle(resolve), settle(reject))
      })
    },
  }
}
