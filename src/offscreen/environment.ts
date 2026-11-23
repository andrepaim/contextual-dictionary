// What the offscreen document downloads and which worker it starts. The
// end-to-end build replaces this module (scripts/build.mjs --e2e) with one
// that points at a local test server; the production build uses this one.
import { ASSET_MANIFEST, type AssetManifest } from '../assets/manifest'

export interface OffscreenEnvironment {
  manifest: AssetManifest
  /** The model worker script. */
  workerUrl: string
  /** The directory of the ONNX Runtime WebAssembly files. */
  wasmBase: string
}

export async function loadEnvironment(getURL: (path: string) => string): Promise<OffscreenEnvironment> {
  return { manifest: ASSET_MANIFEST, workerUrl: getURL('model-worker.js'), wasmBase: getURL('ort/') }
}
