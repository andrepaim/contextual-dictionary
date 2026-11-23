// Builds the unpacked extension into dist/.
//
//   node scripts/build.mjs [--outdir=<directory>]
//
// Bundles every *.entry.ts, copies the manifest (with the package version),
// the HTML pages and the ONNX Runtime WebAssembly files. The output depends
// only on the sources, so two builds of one commit are identical.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const argument = process.argv.find(value => value.startsWith('--outdir='))
const outdir = path.resolve(root, argument ? argument.slice('--outdir='.length) : 'dist')

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

export async function buildExtension(target = outdir) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.join(target, 'ort'), { recursive: true })
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  for (const entry of ENTRIES) {
    await build({
      entryPoints: [path.join(root, entry.source)],
      outfile: path.join(target, entry.output),
      bundle: true,
      format: entry.format,
      platform: 'browser',
      target: 'chrome124',
      legalComments: 'none',
      logLevel: 'warning',
      define: { __VERSION__: JSON.stringify(version) },
      ...(entry.conditions ? { conditions: entry.conditions } : {}),
    })
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  for (const page of PAGES) fs.copyFileSync(path.join(root, page), path.join(target, path.basename(page)))
  for (const file of RUNTIME) fs.copyFileSync(path.join(root, 'node_modules/onnxruntime-web/dist', file), path.join(target, 'ort', file))
  return target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = await buildExtension()
  const size = fs.readdirSync(target, { recursive: true }).reduce((sum, file) => {
    const stat = fs.statSync(path.join(target, file))
    return sum + (stat.isFile() ? stat.size : 0)
  }, 0)
  console.log(`Built ${path.relative(root, target)} (${(size / 1e6).toFixed(1)} MB)`)
}
