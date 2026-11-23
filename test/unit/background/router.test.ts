import { beforeEach, describe, expect, test } from 'vitest'
import { Router, UNKNOWN_RUNTIME } from '../../../src/background/router'
import { RuntimeStatusCache, SettingsStore } from '../../../src/background/settings-store'
import { CodedError, DEFAULT_SETTINGS, type BundleStatus, type Settings } from '../../../src/shared/contracts'
import type { OffscreenRequest, RuntimeStatus } from '../../../src/shared/offscreen-protocol'
import { FakeArea } from './fakes'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN = `chrome-extension://${ID}/`
const POPUP = { id: ID, url: `${ORIGIN}popup.html` }
const POPUP_TAB = { id: ID, url: `${ORIGIN}popup.html`, tab: { id: 3 } }
const CONTENT = { id: ID, url: 'https://news.example/story', tab: { id: 7 }, frameId: 0 }
const selection = { text: 'mouse', before: 'Drag the ', after: ' to move' }

const ready: BundleStatus = { phase: 'ready', error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 42 }
const LIVE: RuntimeStatus = { bundles: { dictionary: ready, model: ready }, ranker: { state: 'ready' } }

class FakeOffscreen {
  exists = false
  calls: Array<{ request: OffscreenRequest; settings: Settings; create: boolean }> = []
  answer: (request: OffscreenRequest) => unknown = request => (request.type === 'define' ? { result: 'r', ordered: false } : request.type === 'cancel-define' ? null : LIVE)
  async call(request: OffscreenRequest, settings: Settings, options: { create: boolean }) {
    this.calls.push({ request, settings, create: options.create })
    if (!options.create && !this.exists) return undefined
    this.exists = true
    return this.answer(request)
  }
}

let area: FakeArea, session: FakeArea, offscreen: FakeOffscreen, router: Router
beforeEach(() => {
  area = new FakeArea()
  session = new FakeArea()
  offscreen = new FakeOffscreen()
  router = new Router({ settings: new SettingsStore(area), offscreen, cache: new RuntimeStatusCache(session), extensionId: ID, extensionOrigin: ORIGIN })
})

const handle = (message: unknown, sender: object) => router.handle(message, sender)

describe('Router: who may send what', () => {
  test('ignores messages from other extensions and senders it does not know', () => {
    expect(handle({ type: 'status' }, { ...POPUP, id: 'other' })).toBeUndefined()
    expect(handle({ type: 'status' }, { id: ID })).toBeUndefined()
    expect(handle({ type: 'status' }, { id: ID, url: 'https://news.example/' })).toBeUndefined()
  })

  test('ignores the messages it sends to the offscreen document', () => {
    expect(handle({ target: 'contextual-dictionary:offscreen', request: { type: 'status' }, settings: DEFAULT_SETTINGS }, POPUP)).toBeUndefined()
  })

  test('answers a malformed request with BAD_REQUEST', async () => {
    expect(await handle({ type: 'define', requestId: '', selection }, CONTENT)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(await handle({ type: 'nothing' }, POPUP)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(offscreen.calls).toEqual([])
  })

  test('content scripts may only ask for the status and look words up', async () => {
    for (const request of [{ type: 'set-settings', patch: { definitions: false } }, { type: 'set-site', host: 'news.example', enabled: false },
      { type: 'download', bundle: 'model', acceptBytes: 1 }, { type: 'cancel-download', bundle: 'model' }, { type: 'remove-assets', bundle: 'dictionary' }]) {
      expect(await handle(request, CONTENT), request.type).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(area.writes).toBe(0)
    expect(offscreen.calls).toEqual([])
  })

  test('the popup opened in a tab is still an extension page', async () => {
    expect(await handle({ type: 'set-settings', patch: { definitions: false } }, POPUP_TAB)).toMatchObject({ ok: true })
  })

  test('counts requests by type', async () => {
    await handle({ type: 'status', host: 'a.org' }, CONTENT)
    await handle({ type: 'define', requestId: 'r1', selection }, CONTENT)
    await handle({ type: 'define', requestId: 'r2', selection }, CONTENT)
    expect(router.stats).toMatchObject({ status: 1, define: 2, 'cancel-define': 0 })
  })
})

describe('Router: status', () => {
  test('a content script gets the settings and its site switch without creating the offscreen document', async () => {
    await new SettingsStore(area).setSite('quiet.example', false)
    const reply = await handle({ type: 'status', host: 'quiet.example' }, CONTENT)
    expect(reply).toEqual({ ok: true, value: { settings: { ...DEFAULT_SETTINGS, disabledSites: ['quiet.example'] }, siteEnabled: false, ...UNKNOWN_RUNTIME } })
    expect(offscreen.calls).toEqual([])
    expect(await handle({ type: 'status', host: 'loud.example' }, CONTENT)).toMatchObject({ value: { siteEnabled: true } })
  })

  test('a content script gets the last status the popup saw, when there is one', async () => {
    await handle({ type: 'status' }, POPUP)
    offscreen.calls = []
    expect(await handle({ type: 'status', host: 'a.org' }, CONTENT)).toMatchObject({ ok: true, value: LIVE })
    expect(offscreen.calls).toEqual([])
  })

  test('the popup gets the live status from the offscreen document, which is remembered', async () => {
    const reply = await handle({ type: 'status', host: 'news.example' }, POPUP)
    expect(reply).toEqual({ ok: true, value: { settings: DEFAULT_SETTINGS, siteEnabled: true, ...LIVE } })
    expect(offscreen.calls).toEqual([{ request: { type: 'status' }, settings: DEFAULT_SETTINGS, create: true }])
    expect(await new RuntimeStatusCache(session).get()).toEqual(LIVE)
  })

  test('the offscreen document failing is reported to the popup', async () => {
    offscreen.answer = () => { throw new CodedError('OFFSCREEN_UNAVAILABLE', 'gone') }
    expect(await handle({ type: 'status' }, POPUP)).toEqual({ ok: false, code: 'OFFSCREEN_UNAVAILABLE', message: 'gone' })
  })

  test('a malformed answer from the offscreen document is NO_RESPONSE', async () => {
    offscreen.answer = () => ({ bundles: 1 })
    expect(await handle({ type: 'status' }, POPUP)).toMatchObject({ ok: false, code: 'NO_RESPONSE' })
  })
})

describe('Router: settings and sites', () => {
  test('a settings change is stored, passed to the offscreen document and answered with the status', async () => {
    const reply = await handle({ type: 'set-settings', patch: { orderByContext: true, budgetMs: 500 }, host: 'news.example' }, POPUP)
    const settings = { ...DEFAULT_SETTINGS, orderByContext: true, budgetMs: 500 }
    expect(reply).toEqual({ ok: true, value: { settings, siteEnabled: true, ...LIVE } })
    expect(offscreen.calls).toEqual([{ request: { type: 'settings' }, settings, create: true }])
    expect(await new SettingsStore(area).get()).toEqual(settings)
  })

  test('the site switch is stored and the answer is for that site', async () => {
    const reply = await handle({ type: 'set-site', host: 'News.example', enabled: false }, POPUP)
    expect(reply).toMatchObject({ ok: true, value: { siteEnabled: false, settings: { disabledSites: ['news.example'] } } })
    expect((await handle({ type: 'set-site', host: 'news.example', enabled: true }, POPUP))).toMatchObject({ value: { siteEnabled: true, settings: { disabledSites: [] } } })
  })

  test('an answer without a host reports the extension as enabled', async () => {
    await new SettingsStore(area).setSite('news.example', false)
    expect(await handle({ type: 'set-settings', patch: { definitions: true } }, POPUP)).toMatchObject({ value: { siteEnabled: true } })
  })

  test('a settings write that fails is reported', async () => {
    area.set = () => Promise.reject(new Error('quota'))
    expect(await handle({ type: 'set-settings', patch: { definitions: false } }, POPUP)).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
  })
})

describe('Router: lookups', () => {
  test('a lookup goes to the offscreen document with the current settings', async () => {
    await new SettingsStore(area).patch({ orderByContext: true })
    const reply = await handle({ type: 'define', requestId: 'r1', selection }, CONTENT)
    expect(reply).toEqual({ ok: true, value: { result: 'r', ordered: false } })
    expect(offscreen.calls).toEqual([{ request: { type: 'define', requestId: 'r1', selection }, settings: { ...DEFAULT_SETTINGS, orderByContext: true }, create: true }])
  })

  test('with definitions off, a lookup is refused without waking the offscreen document', async () => {
    await new SettingsStore(area).patch({ definitions: false })
    expect(await handle({ type: 'define', requestId: 'r1', selection }, CONTENT)).toMatchObject({ ok: false, code: 'DEFINITIONS_OFF' })
    expect(offscreen.calls).toEqual([])
  })

  test('a lookup error from the offscreen document is passed on', async () => {
    offscreen.answer = () => { throw new CodedError('DICTIONARY_MISSING', 'The dictionary is not installed.') }
    expect(await handle({ type: 'define', requestId: 'r1', selection }, CONTENT)).toEqual({ ok: false, code: 'DICTIONARY_MISSING', message: 'The dictionary is not installed.' })
  })

  test('a cancel reaches an existing offscreen document and never creates one', async () => {
    expect(await handle({ type: 'cancel-define', requestId: 'r1' }, CONTENT)).toEqual({ ok: true, value: null })
    expect(offscreen.calls).toEqual([{ request: { type: 'cancel-define', requestId: 'r1' }, settings: DEFAULT_SETTINGS, create: false }])
  })
})

describe('Router: downloads', () => {
  test.each([
    [{ type: 'download', bundle: 'model', acceptBytes: 99 }, { type: 'download', bundle: 'model', acceptBytes: 99 }],
    [{ type: 'cancel-download', bundle: 'dictionary', host: 'news.example' }, { type: 'cancel-download', bundle: 'dictionary' }],
    [{ type: 'remove-assets', bundle: 'model' }, { type: 'remove-assets', bundle: 'model' }],
  ])('%o goes to the offscreen document and is answered with the status', async (request, forwarded) => {
    const reply = await handle(request, POPUP)
    expect(reply).toEqual({ ok: true, value: { settings: DEFAULT_SETTINGS, siteEnabled: true, ...LIVE } })
    expect(offscreen.calls).toEqual([{ request: forwarded, settings: DEFAULT_SETTINGS, create: true }])
    expect(await new RuntimeStatusCache(session).get()).toEqual(LIVE)
  })

  test('a refused download keeps its code and details', async () => {
    offscreen.answer = () => { throw new CodedError('DOWNLOAD_SIZE_CHANGED', 'changed', { requiredBytes: 5 }) }
    expect(await handle({ type: 'download', bundle: 'model', acceptBytes: 99 }, POPUP)).toEqual({ ok: false, code: 'DOWNLOAD_SIZE_CHANGED', message: 'changed', details: { requiredBytes: 5 } })
  })
})
