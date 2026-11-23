import { describe, expect, test } from 'vitest'
import { CodedError, DEFAULT_SETTINGS, REQUEST_TYPES, isRequest, normalizeSettings } from '../../src/shared/contracts'

const selection = { text: 'mouse', before: 'Drag the ', after: ' to move the cursor.' }

describe('isRequest', () => {
  test('accepts one well-formed request of every type', () => {
    const requests = [
      { type: 'define', requestId: 'a1', selection },
      { type: 'cancel-define', requestId: 'a1' },
      { type: 'status' },
      { type: 'status', host: 'example.org' },
      { type: 'set-settings', patch: { orderByContext: true, budgetMs: 400 } },
      { type: 'set-site', host: 'example.org', enabled: false },
      { type: 'download', bundle: 'model', acceptBytes: 150_000_000 },
      { type: 'cancel-download', bundle: 'dictionary' },
      { type: 'remove-assets', bundle: 'model' },
    ]
    for (const request of requests) expect(isRequest(request), request.type).toBe(true)
    expect(new Set(requests.map(request => request.type))).toEqual(new Set(REQUEST_TYPES))
  })

  test('refuses values that are not requests', () => {
    for (const value of [null, undefined, 'define', 7, [], {}, { type: 7 }, { type: 'unknown' }]) expect(isRequest(value)).toBe(false)
  })

  test('refuses a lookup without an id, without text, or with oversized text', () => {
    expect(isRequest({ type: 'define', requestId: '', selection })).toBe(false)
    expect(isRequest({ type: 'define', requestId: 'a1' })).toBe(false)
    expect(isRequest({ type: 'define', requestId: 'a1', selection: { ...selection, text: '   ' } })).toBe(false)
    expect(isRequest({ type: 'define', requestId: 'a1', selection: { ...selection, text: 'x'.repeat(161) } })).toBe(false)
    expect(isRequest({ type: 'define', requestId: 'a1', selection: { ...selection, before: 'x'.repeat(241) } })).toBe(false)
    expect(isRequest({ type: 'define', requestId: 'a1', selection: { ...selection, after: 5 } })).toBe(false)
    expect(isRequest({ type: 'cancel-define', requestId: 'x'.repeat(65) })).toBe(false)
  })

  test('refuses settings it does not know, and wrong value types', () => {
    expect(isRequest({ type: 'set-settings' })).toBe(false)
    expect(isRequest({ type: 'set-settings', patch: { disabledSites: ['a.org'] } })).toBe(false)
    expect(isRequest({ type: 'set-settings', patch: { definitions: 'yes' } })).toBe(false)
    expect(isRequest({ type: 'set-settings', patch: { budgetMs: Number.NaN } })).toBe(false)
    expect(isRequest({ type: 'set-settings', patch: {} })).toBe(true)
  })

  test('requests answered with a status may name the asking page host', () => {
    for (const request of [
      { type: 'set-settings', patch: { definitions: false }, host: 'example.org' },
      { type: 'download', bundle: 'model', acceptBytes: 5, host: 'example.org' },
      { type: 'cancel-download', bundle: 'model', host: 'example.org' },
      { type: 'remove-assets', bundle: 'dictionary', host: 'example.org' },
    ]) {
      expect(isRequest(request), request.type).toBe(true)
      expect(isRequest({ ...request, host: 7 }), request.type).toBe(false)
      expect(isRequest({ ...request, host: 'x'.repeat(256) }), request.type).toBe(false)
    }
  })

  test('refuses malformed site, download and asset requests', () => {
    expect(isRequest({ type: 'status', host: 7 })).toBe(false)
    expect(isRequest({ type: 'set-site', host: '', enabled: true })).toBe(false)
    expect(isRequest({ type: 'set-site', host: 'a.org', enabled: 'no' })).toBe(false)
    expect(isRequest({ type: 'download', bundle: 'other', acceptBytes: 1 })).toBe(false)
    expect(isRequest({ type: 'download', bundle: 'model', acceptBytes: -1 })).toBe(false)
    expect(isRequest({ type: 'download', bundle: 'model', acceptBytes: 1.5 })).toBe(false)
    expect(isRequest({ type: 'cancel-download', bundle: 'other' })).toBe(false)
    expect(isRequest({ type: 'remove-assets' })).toBe(false)
  })
})

describe('normalizeSettings', () => {
  test('missing settings are the defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  test('numbers are rounded and kept inside their limits', () => {
    expect(normalizeSettings({ budgetMs: 5, maxCandidates: 1000 })).toMatchObject({ budgetMs: 50, maxCandidates: 127 })
    expect(normalizeSettings({ budgetMs: 99_999, maxCandidates: 0 })).toMatchObject({ budgetMs: 2000, maxCandidates: 2 })
    expect(normalizeSettings({ budgetMs: 400.6 })).toMatchObject({ budgetMs: 401 })
    expect(normalizeSettings({ budgetMs: Number.NaN, maxCandidates: 'many' as unknown as number })).toMatchObject({ budgetMs: 350, maxCandidates: 48 })
  })

  test('sites are lower-cased, de-duplicated and sorted; other values are dropped', () => {
    const settings = normalizeSettings({ disabledSites: ['B.org', 'a.org', 'b.org', '', 7 as unknown as string], definitions: false, orderByContext: 'yes' as unknown as boolean })
    expect(settings.disabledSites).toEqual(['a.org', 'b.org'])
    expect(settings.definitions).toBe(false)
    expect(settings.orderByContext).toBe(false)
    expect(normalizeSettings({ disabledSites: 'a.org' as unknown as string[] }).disabledSites).toEqual([])
  })
})

test('a coded error carries its code, message and details', () => {
  const error = new CodedError('DOWNLOAD_SIZE_CHANGED', 'The size changed.', { requiredBytes: 5 })
  expect(error).toBeInstanceOf(Error)
  expect(error.code).toBe('DOWNLOAD_SIZE_CHANGED')
  expect(error.message).toBe('The size changed.')
  expect(error.details).toEqual({ requiredBytes: 5 })
  expect(new CodedError('X').message).toBe('X')
})
