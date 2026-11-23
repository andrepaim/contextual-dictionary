import { describe, expect, test } from 'vitest'
import { offscreenHandler } from '../../../src/offscreen/channel'
import { CodedError, DEFAULT_SETTINGS } from '../../../src/shared/contracts'
import { OFFSCREEN_TARGET, type OffscreenRequest } from '../../../src/shared/offscreen-protocol'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const WORKER = { id: ID, url: `chrome-extension://${ID}/service-worker.js` }
const message = (request: OffscreenRequest) => ({ target: OFFSCREEN_TARGET, request, settings: DEFAULT_SETTINGS })

function setup(answer: (request: OffscreenRequest) => Promise<unknown> = async request => request.type) {
  const seen: OffscreenRequest[] = []
  const handle = offscreenHandler({ handle: (request, settings) => { seen.push(request); expect(settings).toEqual(DEFAULT_SETTINGS); return answer(request) } }, { extensionId: ID, serviceWorkerUrl: WORKER.url })
  return { handle, seen }
}

describe('offscreenHandler', () => {
  test('answers requests the service worker forwards', async () => {
    const { handle } = setup()
    expect(await handle(message({ type: 'status' }), WORKER)).toEqual({ ok: true, value: 'status' })
  })

  test('host errors become error replies', async () => {
    const { handle } = setup(() => Promise.reject(new CodedError('DICTIONARY_MISSING', 'none')))
    expect(await handle(message({ type: 'status' }), WORKER)).toEqual({ ok: false, code: 'DICTIONARY_MISSING', message: 'none' })
  })

  test('leaves the requests of pages and content scripts to the service worker', () => {
    const { handle, seen } = setup()
    expect(handle({ type: 'status' }, { id: ID, url: `chrome-extension://${ID}/popup.html` })).toBeUndefined()
    expect(handle({ type: 'define', requestId: 'a', selection: { text: 'a', before: '', after: '' } }, { id: ID, url: 'https://a.org/', tab: { id: 1 } })).toBeUndefined()
    expect(seen).toEqual([])
  })

  test('takes forwarded messages only from the service worker of this extension', () => {
    const { handle, seen } = setup()
    expect(handle(message({ type: 'status' }), { id: ID, url: `chrome-extension://${ID}/popup.html` })).toBeUndefined()
    expect(handle(message({ type: 'status' }), { id: ID, url: 'https://a.org/', tab: { id: 1 } })).toBeUndefined()
    expect(handle(message({ type: 'status' }), { ...WORKER, tab: { id: 1 } })).toBeUndefined()
    expect(handle(message({ type: 'status' }), { ...WORKER, id: 'other' })).toBeUndefined()
    expect(handle({ target: OFFSCREEN_TARGET, request: { type: 'set-site' }, settings: DEFAULT_SETTINGS }, WORKER)).toBeUndefined()
    expect(seen).toEqual([])
  })
})
