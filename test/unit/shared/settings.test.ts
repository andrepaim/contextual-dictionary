import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/contracts'
import { SETTINGS_KEY, activationFromChange, isSiteEnabled, normalizeHost, pageHost } from '../../../src/shared/settings'

describe('normalizeHost', () => {
  test('lower-cases and drops a trailing dot', () => {
    expect(normalizeHost('Example.ORG')).toBe('example.org')
    expect(normalizeHost('example.org.')).toBe('example.org')
    expect(normalizeHost('  a.org ')).toBe('a.org')
  })
})

describe('isSiteEnabled', () => {
  const settings = { ...DEFAULT_SETTINGS, disabledSites: ['quiet.example'] }
  test('a listed host is off, any other host is on', () => {
    expect(isSiteEnabled(settings, 'quiet.example')).toBe(false)
    expect(isSiteEnabled(settings, 'QUIET.example.')).toBe(false)
    expect(isSiteEnabled(settings, 'loud.example')).toBe(true)
    expect(isSiteEnabled(settings, 'sub.quiet.example')).toBe(true)
  })
  test('no host (a file or a blank frame) is on', () => {
    expect(isSiteEnabled(settings, undefined)).toBe(true)
    expect(isSiteEnabled(settings, '')).toBe(true)
  })
})

describe('pageHost', () => {
  const list = (...origins: string[]) => Object.assign([...origins], { contains: (value: string) => origins.includes(value), item: (index: number) => origins[index] ?? null })
  test('a top-level page is its own host', () => {
    expect(pageHost({ hostname: 'Example.org', ancestorOrigins: list() })).toBe('example.org')
    expect(pageHost({ hostname: 'example.org' })).toBe('example.org')
  })
  test('a frame takes the host of the top-level page, so the site switch covers the whole tab', () => {
    expect(pageHost({ hostname: 'ads.example', ancestorOrigins: list('https://middle.example', 'https://top.example:8443') })).toBe('top.example')
  })
  test('an opaque or unreadable top origin falls back to the frame host', () => {
    expect(pageHost({ hostname: 'frame.example', ancestorOrigins: list('null') })).toBe('frame.example')
    expect(pageHost({ hostname: 'frame.example', ancestorOrigins: list('not a url') })).toBe('frame.example')
  })
})

describe('activationFromChange', () => {
  test('a change of the settings key becomes the state the controller applies', () => {
    const changes = { [SETTINGS_KEY]: { newValue: { definitions: true, disabledSites: ['quiet.example'] } } }
    expect(activationFromChange(changes, 'local', 'quiet.example')).toEqual({ settings: { ...DEFAULT_SETTINGS, disabledSites: ['quiet.example'] }, siteEnabled: false })
    expect(activationFromChange(changes, 'local', 'other.example')?.siteEnabled).toBe(true)
  })
  test('removed settings are the defaults', () => {
    expect(activationFromChange({ [SETTINGS_KEY]: {} }, 'local', 'a.org')).toEqual({ settings: DEFAULT_SETTINGS, siteEnabled: true })
  })
  test('other keys and other storage areas are ignored', () => {
    expect(activationFromChange({ other: { newValue: 1 } }, 'local', 'a.org')).toBeNull()
    expect(activationFromChange({ [SETTINGS_KEY]: { newValue: {} } }, 'session', 'a.org')).toBeNull()
    expect(activationFromChange({ [SETTINGS_KEY]: { newValue: {} } }, 'sync', 'a.org')).toBeNull()
  })
})
