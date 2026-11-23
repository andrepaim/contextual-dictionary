// Builds the unpacked extension into dist/.
//
//   node scripts/build.mjs [--outdir=<directory>] [--e2e]
//
// Bundles every *.entry.ts, copies the manifest (with the package version),
// the HTML pages and the ONNX Runtime WebAssembly files. The output depends
// only on the sources, so two builds of one commit are identical.
//
// --e2e builds the end-to-end test variant (default directory dist-e2e/): the
// offscreen document reads its asset manifest from e2e-config.json (written
// by the test setup, pointing at a loopback server), the model worker is a
// deterministic fake from test/e2e/variant/, and the content security policy
// and host permissions also allow http://127.0.0.1. ONNX Runtime is left out,
// since the fake does not use it. The production build contains none of
// this; scripts/check-build.mjs proves it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Entry file, output name, and module format. The content script cannot be a module. */
export const ENTRIES = [
  { source: 'src/background/service-worker.entry.ts', output: 'service-worker.js', format: 'esm' },
  { source: 'src/content/content.entry.ts', output: 'content.js', format: 'iife' },
  { source: 'src/offscreen/offscreen.entry.ts', output: 'offscreen.js', format: 'esm' },
  // The extern-wasm condition picks the ONNX Runtime build that imports its loader from
  // dist/ort/ instead of embedding it, so the runtime's thread workers start from that loader.
  { source: 'src/model/worker.entry.ts', output: 'model-worker.js', format: 'esm', conditions: ['onnxruntime-web-use-extern-wasm', 'module'] },
  { source: 'src/popup/popup.entry.ts', output: 'popup.js', format: 'esm' },
]
const PAGES = ['src/offscreen/offscreen.html', 'src/popup/popup.html']
/** The CPU (WebAssembly) runtime: one loader and one binary. */
const RUNTIME = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']

/** What the end-to-end variant swaps in. */
export const E2E = {
  /** A string every swapped-in module contains; the production check looks for it. */
  marker: '__CD_E2E_VARIANT__',
  environment: 'test/e2e/variant/environment.ts',
  worker: 'test/e2e/variant/fake-model-worker.ts',
  hostPermission: 'http://127.0.0.1/*',
  connectSource: 'http://127.0.0.1:*',
}

/** Resolves the offscreen document's ./environment import to the end-to-end module. */
const e2eEnvironment = {
  name: 'e2e-environment',
  setup(builder) {
    const production = path.join(root, 'src/offscreen/environment.ts')
    builder.onResolve({ filter: /\/environment$/ }, args => {
      const resolved = path.resolve(args.resolveDir, `${args.path}.ts`)
      return resolved === production ? { path: path.join(root, E2E.environment) } : undefined
    })
  },
}

/** The manifest of the build: the package version, and for the e2e variant loopback access. */
export function buildManifest(manifest, version, e2e = false) {
  const out = { ...manifest, version }
  if (!e2e) return out
  out.host_permissions = [...(manifest.host_permissions ?? []), E2E.hostPermission]
  out.content_security_policy = {
    ...manifest.content_security_policy,
    extension_pages: manifest.content_security_policy.extension_pages.replace(/connect-src ([^;]*)/, (_, sources) => `connect-src ${sources} ${E2E.connectSource}`),
  }
  return out
}

export async function buildExtension(target, { e2e = false } = {}) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.join(target, 'ort'), { recursive: true })
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  for (const entry of ENTRIES) {
    const fake = e2e && entry.output === 'model-worker.js'
    await build({
      entryPoints: [path.join(root, fake ? E2E.worker : entry.source)],
      outfile: path.join(target, entry.output),
      bundle: true,
      format: entry.format,
      platform: 'browser',
      target: 'chrome124',
      legalComments: 'none',
      logLevel: 'warning',
      define: { __VERSION__: JSON.stringify(version) },
      plugins: e2e ? [e2eEnvironment] : [],
      ...(entry.conditions && !fake ? { conditions: entry.conditions } : {}),
    })
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(buildManifest(manifest, version, e2e), null, 2)}\n`)
  for (const page of PAGES) fs.copyFileSync(path.join(root, page), path.join(target, path.basename(page)))
  if (!e2e) for (const file of RUNTIME) fs.copyFileSync(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(target, 'ort', file))
  return target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e2e = process.argv.includes('--e2e')
  const argument = process.argv.find(value => value.startsWith('--outdir='))
  const outdir = path.resolve(root, argument ? argument.slice('--outdir='.length) : e2e ? 'dist-e2e' : 'dist')
  const target = await buildExtension(outdir, { e2e })
  const size = fs.readdirSync(target, { recursive: true }).reduce((sum, file) => {
    const stat = fs.statSync(path.join(target, file))
    return sum + (stat.isFile() ? stat.size : 0)
  }, 0)
  console.log(`Built ${path.relative(root, target)}${e2e ? ' (end-to-end variant)' : ''} (${(size / 1e6).toFixed(1)} MB)`)
}
