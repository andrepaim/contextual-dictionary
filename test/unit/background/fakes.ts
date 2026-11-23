import type { StorageAreaLike } from '../../../src/background/settings-store'

/** chrome.storage.local in memory, with values copied like the real one. */
export class FakeArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>()
  writes = 0
  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {}
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.writes++
    await new Promise(resolve => setTimeout(resolve, 1))
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value))
  }
}

