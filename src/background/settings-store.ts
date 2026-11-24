// The settings in chrome.storage.local, and the last status the offscreen
// document reported in chrome.storage.session. The service worker can stop at
// any moment, so nothing here is kept in memory between calls.
import { normalizeSettings, type Settings } from '../shared/contracts'
import { isRuntimeStatus, type RuntimeStatus } from '../shared/offscreen-protocol'
import { SETTINGS_KEY, normalizeHost } from '../shared/settings'

/** The part of a chrome.storage area these stores use. */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

const PATCHABLE = ['definitions', 'orderByContext', 'showOrderDetails', 'budgetMs', 'maxCandidates'] as const

export class SettingsStore {
  /** Changes run one after another, so two quick switches in the popup do not undo each other. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly area: StorageAreaLike) {}

  async get(): Promise<Settings> {
    const stored = await this.area.get(SETTINGS_KEY)
    return normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined)
  }

  patch(patch: Partial<Omit<Settings, 'disabledSites'>>): Promise<Settings> {
    return this.#change(current => {
      const next: Settings = { ...current }
      for (const key of PATCHABLE) if (patch[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = patch[key]
      return next
    })
  }

  setSite(host: string, enabled: boolean): Promise<Settings> {
    const site = normalizeHost(host)
    return this.#change(current => ({
      ...current,
      disabledSites: enabled ? current.disabledSites.filter(entry => entry !== site) : [...current.disabledSites, site],
    }))
  }

  #change(update: (current: Settings) => Settings): Promise<Settings> {
    const run = this.#queue.catch(() => undefined).then(async () => {
      const next = normalizeSettings(update(await this.get()))
      await this.area.set({ [SETTINGS_KEY]: next })
      return next
    })
    this.#queue = run
    return run
  }
}

const RUNTIME_KEY = 'runtimeStatus'

/** The bundle and model status last seen, for answers that must not wake the offscreen document. A hint only. */
export class RuntimeStatusCache {
  constructor(private readonly area: StorageAreaLike) {}

  async get(): Promise<RuntimeStatus | undefined> {
    try {
      const value = (await this.area.get(RUNTIME_KEY))[RUNTIME_KEY]
      return isRuntimeStatus(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  async set(status: RuntimeStatus): Promise<void> {
    try { await this.area.set({ [RUNTIME_KEY]: status }) } catch { /* a hint only */ }
  }
}
