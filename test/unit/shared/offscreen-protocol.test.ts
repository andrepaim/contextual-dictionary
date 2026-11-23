import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/contracts'
import { OFFSCREEN_TARGET, isOffscreenMessage, isRuntimeStatus, offscreenMessage } from '../../../src/shared/offscreen-protocol'

const bundle = { phase: 'ready', error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 10 }

describe('offscreen messages', () => {
  test('wraps a request with the current settings', () => {
    expect(offscreenMessage({ type: 'status' }, DEFAULT_SETTINGS)).toEqual({ target: OFFSCREEN_TARGET, request: { type: 'status' }, settings: DEFAULT_SETTINGS })
  })
  test('recognises its own messages only', () => {
    const selection = { text: 'mouse', before: '', after: '' }
    for (const request of [{ type: 'status' }, { type: 'settings' }, { type: 'define', requestId: 'a', selection }, { type: 'cancel-define', requestId: 'a' },
      { type: 'download', bundle: 'model', acceptBytes: 5 }, { type: 'cancel-download', bundle: 'model' }, { type: 'remove-assets', bundle: 'dictionary' }]) {
      expect(isOffscreenMessage({ target: OFFSCREEN_TARGET, request, settings: DEFAULT_SETTINGS }), request.type).toBe(true)
    }
    expect(isOffscreenMessage({ type: 'status' })).toBe(false)
    expect(isOffscreenMessage(null)).toBe(false)
    expect(isOffscreenMessage({ target: 'other', request: { type: 'status' }, settings: DEFAULT_SETTINGS })).toBe(false)
    expect(isOffscreenMessage({ target: OFFSCREEN_TARGET, request: { type: 'set-site', host: 'a', enabled: true }, settings: DEFAULT_SETTINGS })).toBe(false)
    expect(isOffscreenMessage({ target: OFFSCREEN_TARGET, request: { type: 'define' }, settings: DEFAULT_SETTINGS })).toBe(false)
    expect(isOffscreenMessage({ target: OFFSCREEN_TARGET, request: { type: 'status' } })).toBe(false)
  })
})

describe('isRuntimeStatus', () => {
  test('accepts the bundle and ranker part of a status', () => {
    expect(isRuntimeStatus({ bundles: { dictionary: bundle, model: bundle }, ranker: { state: 'idle' } })).toBe(true)
    expect(isRuntimeStatus({ bundles: { dictionary: bundle, model: bundle }, ranker: { state: 'failed', code: 'X' } })).toBe(true)
  })
  test('refuses anything else', () => {
    for (const value of [undefined, {}, { bundles: { dictionary: bundle }, ranker: { state: 'idle' } }, { bundles: { dictionary: bundle, model: { phase: 'odd' } }, ranker: { state: 'idle' } },
      { bundles: { dictionary: bundle, model: bundle }, ranker: { state: 'weird' } }, { bundles: { dictionary: bundle, model: bundle } }]) expect(isRuntimeStatus(value)).toBe(false)
  })
})
