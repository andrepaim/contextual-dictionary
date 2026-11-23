// End-to-end variant of src/offscreen/environment.ts, swapped in by
// `node scripts/build.mjs --e2e`. The asset manifest comes from
// e2e-config.json, which the test setup writes next to the built files with
// the loopback server's address and the pins of the fixture files.
import { assertManifest } from '../../../src/assets/manifest'
import type { OffscreenEnvironment } from '../../../src/offscreen/environment'

/** Marks the variant; scripts/check-build.mjs fails a production build that contains it. */
export const E2E_MARKER = '__CD_E2E_VARIANT__'

export async function loadEnvironment(getURL: (path: string) => string): Promise<OffscreenEnvironment> {
  const config = await (await fetch(getURL('e2e-config.json'))).json() as { manifest: unknown }
  Object.assign(globalThis, { [E2E_MARKER]: true })
  return { manifest: assertManifest(config.manifest), workerUrl: getURL('model-worker.js'), wasmBase: getURL('ort/') }
}
