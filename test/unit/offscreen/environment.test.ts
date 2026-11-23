import { describe, expect, test } from 'vitest'
import { ASSET_MANIFEST } from '../../../src/assets/manifest'
import { loadEnvironment } from '../../../src/offscreen/environment'

describe('loadEnvironment', () => {
  test('the production build downloads the pinned release and runs the bundled model worker', async () => {
    const environment = await loadEnvironment(path => `chrome-extension://id/${path}`)
    expect(environment.manifest).toBe(ASSET_MANIFEST)
    expect(environment.workerUrl).toBe('chrome-extension://id/model-worker.js')
    expect(environment.wasmBase).toBe('chrome-extension://id/ort/')
  })
})
