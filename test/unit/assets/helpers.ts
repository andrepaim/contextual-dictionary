// Fixtures for the asset tests: small payloads with real pins, a manifest
// that points at them, and a mocked fetch that streams them in chunks.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { AssetManifest, ManifestFile, PinnedFile } from '../../../src/assets/manifest'

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed
  for (let i = 0; i < length; i++) { state = (Math.imul(state, 1103515245) + 12345) >>> 0; out[i] = state >>> 24 }
  return out
}

/** Text compresses, so gzip fixtures are visibly smaller than their stored form. */
export const text = (length: number, word = 'meaning ') => new TextEncoder().encode(word.repeat(Math.ceil(length / word.length)).slice(0, length))

export function identityFile(name: string, stored: Uint8Array): { file: PinnedFile; transfer: Uint8Array } {
  return { file: { name, size: stored.length, sha256: sha(stored), storedName: name, storedSize: stored.length, storedSha256: sha(stored), encoding: 'identity' }, transfer: stored }
}

export function gzipFile(name: string, storedName: string, stored: Uint8Array): { file: PinnedFile; transfer: Uint8Array } {
  const transfer = new Uint8Array(gzipSync(stored))
  return { file: { name, size: transfer.length, sha256: sha(transfer), storedName, storedSize: stored.length, storedSha256: sha(stored), encoding: 'gzip' }, transfer }
}

export const BASE = 'https://assets.test/releases/download'

/** A two-bundle fixture: the dictionary is one plain file, the model one gzip file and two plain ones. */
export function fixture() {
  const pack = identityFile('wiktionary-test.pack', bytes(5000, 7))
  const onnx = gzipFile('model.onnx.gz', 'model.onnx', text(20_000))
  const metadata = identityFile('model_metadata.json', new TextEncoder().encode('{"template_version":"compact-v1"}'))
  const tokenizer = identityFile('tokenizer.json', bytes(3000, 3))
  const manifest: AssetManifest = { tag: 'assets-test', baseUrl: BASE, bundles: { dictionary: [pack.file], model: [onnx.file, metadata.file, tokenizer.file] } }
  const bodies = new Map<string, Uint8Array>([pack, onnx, metadata, tokenizer].map(({ file, transfer }) => [`${BASE}/assets-test/${file.name}`, transfer]))
  const size = (files: ManifestFile[]) => files.reduce((sum, file) => sum + (file.size ?? 0), 0)
  return { manifest, bodies, pack, onnx, metadata, tokenizer, dictionaryBytes: size(manifest.bundles.dictionary), modelBytes: size(manifest.bundles.model) }
}

/** A streamed body that sends `data` in chunks of `chunk` bytes, then optionally fails or hangs. */
export function body(data: Uint8Array, options: { chunk?: number; after?: 'error' | 'hang'; error?: unknown } = {}): ReadableStream<Uint8Array> {
  const chunk = options.chunk ?? 1024
  let at = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < data.length) {
        controller.enqueue(data.slice(at, at + chunk))
        at += chunk
        return
      }
      if (options.after === 'error') controller.error(options.error ?? new TypeError('network error'))
      else if (options.after === 'hang') return new Promise<void>(() => {})
      else controller.close()
    },
  }, { highWaterMark: 0 })
}

/** Rejects like the real fetch when `signal` aborts. */
export function abortable<T>(signal: AbortSignal | undefined | null, value: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    value.then(resolve, reject)
  })
}

export type Calls = Array<{ url: string; init: RequestInit | undefined }>

/** A fetch that serves `bodies` by URL; `override` may answer a call differently. */
export function mockFetch(bodies: Map<string, Uint8Array>, override?: (url: string, init: RequestInit | undefined, call: number) => Promise<Response> | Response | undefined) {
  const calls: Calls = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const custom = override?.(url, init, calls.length)
    if (custom) return abortable(init?.signal, Promise.resolve(custom))
    const data = bodies.get(url)
    if (!data) return new Response('not found', { status: 404 })
    return new Response(body(data), { status: 200 })
  }
  return { fetch, calls }
}

/** A promise with its resolver, for holding a step until the test releases it. */
export function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await tick(2)
  }
}
