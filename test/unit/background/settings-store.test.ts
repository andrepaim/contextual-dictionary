import { describe, expect, test } from 'vitest'
import { RuntimeStatusCache, SettingsStore } from '../../../src/background/settings-store'
import { FakeArea } from './fakes'
import { DEFAULT_SETTINGS } from '../../../src/shared/contracts'
import { SETTINGS_KEY } from '../../../src/shared/settings'

describe('SettingsStore', () => {
  test('nothing stored reads as the defaults', async () => {
    expect(await new SettingsStore(new FakeArea()).get()).toEqual(DEFAULT_SETTINGS)
  })

  test('stored values are normalised when read', async () => {
    const area = new FakeArea()
    area.data.set(SETTINGS_KEY, { budgetMs: 99_999, disabledSites: ['B.org', 'a.org', 3], extra: true })
    expect(await new SettingsStore(area).get()).toEqual({ ...DEFAULT_SETTINGS, budgetMs: 2000, disabledSites: ['a.org', 'b.org'] })
  })

  test('a patch is merged, normalised and written under the settings key', async () => {
    const area = new FakeArea()
    const store = new SettingsStore(area)
    expect(await store.patch({ orderByContext: true, budgetMs: 10 })).toEqual({ ...DEFAULT_SETTINGS, orderByContext: true, budgetMs: 50 })
    expect(area.data.get(SETTINGS_KEY)).toEqual({ ...DEFAULT_SETTINGS, orderByContext: true, budgetMs: 50 })
    expect(await store.patch({ definitions: false })).toEqual({ ...DEFAULT_SETTINGS, orderByContext: true, budgetMs: 50, definitions: false })
  })

  test('only known settings are taken from a patch', async () => {
    const store = new SettingsStore(new FakeArea())
    const patched = await store.patch({ definitions: false, disabledSites: ['x.org'] } as never)
    expect(patched.disabledSites).toEqual([])
  })

  test('sites are switched off and on by host name', async () => {
    const store = new SettingsStore(new FakeArea())
    expect((await store.setSite('Quiet.example', false)).disabledSites).toEqual(['quiet.example'])
    expect((await store.setSite('other.example', false)).disabledSites).toEqual(['other.example', 'quiet.example'])
    expect((await store.setSite('quiet.example.', true)).disabledSites).toEqual(['other.example'])
    expect((await store.setSite('never.example', true)).disabledSites).toEqual(['other.example'])
  })

  test('concurrent changes are applied one after another, so none is lost', async () => {
    const store = new SettingsStore(new FakeArea())
    await Promise.all([store.setSite('a.org', false), store.setSite('b.org', false), store.patch({ orderByContext: true })])
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, orderByContext: true, disabledSites: ['a.org', 'b.org'] })
  })

  test('a failed write does not block later ones', async () => {
    const area = new FakeArea()
    const store = new SettingsStore(area)
    const set = area.set.bind(area)
    area.set = async () => { area.set = set; throw new Error('quota') }
    await expect(store.patch({ definitions: false })).rejects.toThrow('quota')
    expect((await store.patch({ orderByContext: true })).orderByContext).toBe(true)
  })
})

describe('RuntimeStatusCache', () => {
  const bundle = { phase: 'ready' as const, error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 5 }
  const runtime = { bundles: { dictionary: bundle, model: bundle }, ranker: { state: 'ready' as const } }

  test('keeps the last status the offscreen document reported', async () => {
    const cache = new RuntimeStatusCache(new FakeArea())
    expect(await cache.get()).toBeUndefined()
    await cache.set(runtime)
    expect(await cache.get()).toEqual(runtime)
  })

  test('a damaged entry reads as unknown', async () => {
    const area = new FakeArea()
    area.data.set('runtimeStatus', { bundles: 5 })
    expect(await new RuntimeStatusCache(area).get()).toBeUndefined()
  })

  test('storage failures are ignored: the cache is only a hint', async () => {
    const area = new FakeArea()
    area.get = () => Promise.reject(new Error('gone'))
    area.set = () => Promise.reject(new Error('gone'))
    const cache = new RuntimeStatusCache(area)
    await expect(cache.set(runtime)).resolves.toBeUndefined()
    expect(await cache.get()).toBeUndefined()
  })
})
