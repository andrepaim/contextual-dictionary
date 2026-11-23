import { describe, expect, test } from 'vitest'
import type { BundleStatus, FileStore } from '../../../src/shared/contracts'
import { CodedError } from '../../../src/shared/contracts'
import { MemoryFileStore } from '../../../src/assets/file-store'
import { ASSET_MANIFEST, type AssetManifest } from '../../../src/assets/manifest'
import { LocalAssetService, createAssetService } from '../../../src/assets/service'
import { abortable, body, fixture, gate, mockFetch, until } from './helpers'

const idle = (requiredBytes: number, extra: Partial<BundleStatus> = {}): BundleStatus => ({ phase: 'missing', error: null, requiredBytes, receivedBytes: 0, totalBytes: 0, storedBytes: 0, ...extra })

function setup(options: { store?: MemoryFileStore; manifest?: AssetManifest; override?: Parameters<typeof mockFetch>[1]; stallMs?: number } = {}) {
  const data = fixture()
  const store = options.store ?? new MemoryFileStore()
  const network = mockFetch(data.bodies, options.override)
  const service = new LocalAssetService({ store, manifest: options.manifest ?? data.manifest, fetch: network.fetch, stallMs: options.stallMs ?? 1000 })
  return { ...data, store, service, calls: network.calls, fetch: network.fetch }
}

async function install(service: LocalAssetService, bundle: 'dictionary' | 'model') {
  const required = (await service.status())[bundle].requiredBytes
  await service.startDownload(bundle, required)
  await service.settled(bundle)
}

const read = async (service: LocalAssetService, name: string) => {
  const source = await service.open(name)
  return source && source.read(0, source.size)
}

describe('status', () => {
  test('starts with both bundles missing and the size each download would transfer', async () => {
    const { service, dictionaryBytes, modelBytes, calls } = setup()
    expect(await service.status()).toEqual({ dictionary: idle(dictionaryBytes), model: idle(modelBytes) })
    expect(calls).toHaveLength(0)
  })

  test('an unpublished bundle is missing with DOWNLOAD_UNAVAILABLE and cannot be downloaded', async () => {
    const data = fixture()
    const manifest = structuredClone(data.manifest)
    manifest.bundles.model[0] = { ...manifest.bundles.model[0]!, size: null, sha256: null }
    const { service, calls } = setup({ manifest })
    const status = await service.status()
    expect(status.model).toEqual(idle(0, { error: 'DOWNLOAD_UNAVAILABLE' }))
    expect(status.dictionary).toEqual(idle(data.dictionaryBytes))
    await expect(service.startDownload('model', 0)).rejects.toMatchObject({ code: 'DOWNLOAD_UNAVAILABLE' })
    await expect(service.startDownload('model', data.modelBytes)).rejects.toMatchObject({ code: 'DOWNLOAD_UNAVAILABLE' })
    expect(calls).toHaveLength(0)
  })

  test('the real manifest reports both bundles as not yet available', async () => {
    const service = createAssetService({ store: new MemoryFileStore(), fetch: () => Promise.reject(new Error('no network')) })
    const status = await service.status()
    expect(status.model.error).toBe('DOWNLOAD_UNAVAILABLE')
    expect(status.dictionary.error).toBe('DOWNLOAD_UNAVAILABLE')
    expect(ASSET_MANIFEST.bundles.model).toHaveLength(5)
  })

  test('refuses an invalid manifest when constructed', () => {
    expect(() => new LocalAssetService({ store: new MemoryFileStore(), manifest: { tag: '../x' } as unknown as AssetManifest })).toThrow(CodedError)
  })
})

describe('download', () => {
  test('a confirmed download reports progress, installs every file and makes them readable', async () => {
    const held = gate()
    const { service, store, onnx, metadata, tokenizer, modelBytes, calls } = setup({
      override: (url, init) => url.endsWith('/tokenizer.json') ? abortable(init?.signal, held.promise.then(() => new Response(body(tokenizer.transfer)))) : undefined,
    })
    await service.startDownload('model', modelBytes)
    await until(async () => (await service.status()).model.receivedBytes === onnx.file.size + metadata.file.size)
    const during = (await service.status()).model
    expect(during).toMatchObject({ phase: 'downloading', error: null, requiredBytes: tokenizer.file.size, totalBytes: modelBytes })
    expect(await service.open('model.onnx')).toBeUndefined()
    held.open()
    await service.settled('model')
    const after = (await service.status()).model
    expect(after).toEqual({ phase: 'ready', error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: onnx.file.storedSize + metadata.file.storedSize + tokenizer.file.storedSize })
    expect(calls.map(call => call.url.split('/').pop())).toEqual(['model.onnx.gz', 'model_metadata.json', 'tokenizer.json'])
    expect(await read(service, 'model_metadata.json')).toEqual(metadata.transfer)
    expect((await read(service, 'model.onnx'))!.length).toBe(onnx.file.storedSize)
    expect(store.pendingWrites()).toBe(0)
  })

  test('the phase is installing once every byte has arrived', async () => {
    const held = gate()
    const memory = new MemoryFileStore()
    const store: FileStore = {
      open: name => memory.open(name), remove: name => memory.remove(name), list: () => memory.list(),
      create: async name => {
        const writer = await memory.create(name)
        return { write: chunk => writer.write(chunk), abort: () => writer.abort(), commit: async () => { await held.promise; await writer.commit() } }
      },
    }
    const data = fixture()
    const network = mockFetch(data.bodies)
    const service = new LocalAssetService({ store, manifest: data.manifest, fetch: network.fetch })
    await service.startDownload('dictionary', data.dictionaryBytes)
    await until(async () => (await service.status()).dictionary.phase === 'installing')
    expect((await service.status()).dictionary).toMatchObject({ receivedBytes: data.dictionaryBytes, totalBytes: data.dictionaryBytes })
    held.open()
    await service.settled('dictionary')
    expect((await service.status()).dictionary.phase).toBe('ready')
  })

  test('refuses a size other than the one shown, with the current size in the details', async () => {
    const { service, dictionaryBytes, calls } = setup()
    const refused = service.startDownload('dictionary', dictionaryBytes + 1)
    await expect(refused).rejects.toMatchObject({ code: 'DOWNLOAD_SIZE_CHANGED', details: { requiredBytes: dictionaryBytes } })
    expect((await service.status()).dictionary).toEqual(idle(dictionaryBytes))
    expect(calls).toHaveLength(0)
    await install(service, 'dictionary')
    await expect(service.startDownload('dictionary', dictionaryBytes)).rejects.toMatchObject({ code: 'DOWNLOAD_SIZE_CHANGED', details: { requiredBytes: 0 } })
    await service.startDownload('dictionary', 0)
    expect(calls).toHaveLength(1)
  })

  test('concurrent starts of one bundle share one download', async () => {
    const { service, modelBytes, calls } = setup()
    await Promise.all([service.startDownload('model', modelBytes), service.startDownload('model', modelBytes), service.startDownload('model', 1)])
    await service.settled('model')
    expect(calls).toHaveLength(3)
    expect((await service.status()).model.phase).toBe('ready')
  })

  test('the two bundles download independently', async () => {
    const { service, modelBytes, dictionaryBytes } = setup()
    await Promise.all([service.startDownload('model', modelBytes), service.startDownload('dictionary', dictionaryBytes)])
    await Promise.all([service.settled('model'), service.settled('dictionary')])
    const status = await service.status()
    expect([status.model.phase, status.dictionary.phase]).toEqual(['ready', 'ready'])
  })

  test('installed files are reused by a new session without any network call', async () => {
    const first = setup()
    await install(first.service, 'model')
    await install(first.service, 'dictionary')
    const again = setup({ store: first.store })
    const status = await again.service.status()
    expect([status.model.phase, status.dictionary.phase]).toEqual(['ready', 'ready'])
    expect(await read(again.service, 'wiktionary-test.pack')).toEqual(first.pack.transfer)
    expect(await read(again.service, 'model.onnx')).toBeDefined()
    expect(again.calls).toHaveLength(0)
  })

  test('a failed download reports its code and a retry downloads only the files still missing', async () => {
    let fail = true
    const { service, onnx, metadata, tokenizer, modelBytes, calls } = setup({
      override: url => url.endsWith('/tokenizer.json') && fail ? new Response('gone', { status: 500 }) : undefined,
    })
    await service.startDownload('model', modelBytes)
    await service.settled('model')
    expect((await service.status()).model).toEqual(idle(tokenizer.file.size, { phase: 'failed', error: 'DOWNLOAD_FAILED', storedBytes: onnx.file.storedSize + metadata.file.storedSize }))
    expect(await service.open('model.onnx')).toBeUndefined()
    fail = false
    await expect(service.startDownload('model', modelBytes)).rejects.toMatchObject({ code: 'DOWNLOAD_SIZE_CHANGED' })
    await service.startDownload('model', tokenizer.file.size)
    await service.settled('model')
    expect((await service.status()).model.phase).toBe('ready')
    expect(calls.map(call => call.url.split('/').pop())).toEqual(['model.onnx.gz', 'model_metadata.json', 'tokenizer.json', 'tokenizer.json'])
  })

  test('a stalled or corrupt download fails with its code and leaves no partial file', async () => {
    const stalled = setup({ stallMs: 20, override: () => new Response(body(new Uint8Array(100), { after: 'hang' })) })
    await install(stalled.service, 'dictionary')
    expect((await stalled.service.status()).dictionary).toMatchObject({ phase: 'failed', error: 'DOWNLOAD_STALLED', storedBytes: 0 })
    expect(stalled.store.pendingWrites()).toBe(0)

    const corrupt = setup({ override: () => new Response(body(new Uint8Array(5000))) })
    await install(corrupt.service, 'dictionary')
    expect((await corrupt.service.status()).dictionary).toMatchObject({ phase: 'failed', error: 'ASSET_CORRUPT' })
    expect(await corrupt.store.list()).toEqual([])
  })

  test('a full disk is reported as DISK_FULL', async () => {
    const { service } = setup({ store: new MemoryFileStore({ quotaBytes: 1000 }) })
    await install(service, 'dictionary')
    expect((await service.status()).dictionary).toMatchObject({ phase: 'failed', error: 'DISK_FULL' })
  })

  test('an unexpected failure is reported as INSTALL_FAILED', async () => {
    const memory = new MemoryFileStore()
    const store: FileStore = { open: name => memory.open(name), remove: name => memory.remove(name), list: () => memory.list(), create: () => { throw new Error('sync failure') } }
    const data = fixture()
    const service = new LocalAssetService({ store, manifest: data.manifest, fetch: mockFetch(data.bodies).fetch })
    await install(service, 'dictionary')
    expect((await service.status()).dictionary).toMatchObject({ phase: 'failed', error: 'INSTALL_FAILED' })
  })
})

describe('cancel', () => {
  test('cancelling while waiting for the server, mid-transfer, or between files stops and leaves nothing partial', async () => {
    // Waiting for the server.
    const waiting = setup({ override: (_url, init) => abortable(init?.signal, new Promise<Response>(() => {})) })
    await waiting.service.startDownload('dictionary', waiting.dictionaryBytes)
    await until(() => waiting.calls.length === 1)
    await waiting.service.cancel('dictionary')
    expect((await waiting.service.status()).dictionary).toEqual(idle(waiting.dictionaryBytes))
    expect(waiting.store.pendingWrites()).toBe(0)

    // Mid-transfer.
    const transferring = setup({ override: url => url.endsWith('.pack') ? new Response(body(fixture().pack.transfer.slice(0, 2000), { after: 'hang' })) : undefined })
    await transferring.service.startDownload('dictionary', transferring.dictionaryBytes)
    await until(async () => (await transferring.service.status()).dictionary.receivedBytes === 2000)
    await transferring.service.cancel('dictionary')
    expect((await transferring.service.status()).dictionary).toEqual(idle(transferring.dictionaryBytes))
    expect(await transferring.store.list()).toEqual([])
    expect(transferring.store.pendingWrites()).toBe(0)

    // Between files: the first model file is kept, verified, and the next download skips it.
    const held = gate()
    const between = setup({ override: (url, init) => url.endsWith('/model_metadata.json') ? abortable(init?.signal, held.promise.then(() => new Response('x'))) : undefined })
    await between.service.startDownload('model', between.modelBytes)
    await until(() => between.calls.length === 2)
    await between.service.cancel('model')
    const status = (await between.service.status()).model
    expect(status).toEqual(idle(between.metadata.file.size + between.tokenizer.file.size, { storedBytes: between.onnx.file.storedSize }))
    expect(between.store.pendingWrites()).toBe(0)
  })

  test('cancelling while the last file is being put in place lets that verified file stay', async () => {
    const held = gate()
    const memory = new MemoryFileStore()
    let committing = false
    const store: FileStore = {
      open: name => memory.open(name), remove: name => memory.remove(name), list: () => memory.list(),
      create: async name => {
        const writer = await memory.create(name)
        return { write: chunk => writer.write(chunk), abort: () => writer.abort(), commit: async () => { committing = true; await held.promise; await writer.commit() } }
      },
    }
    const data = fixture()
    const service = new LocalAssetService({ store, manifest: data.manifest, fetch: mockFetch(data.bodies).fetch })
    await service.startDownload('dictionary', data.dictionaryBytes)
    await until(() => committing)
    const cancelled = service.cancel('dictionary')
    held.open()
    await cancelled
    expect((await service.status()).dictionary.phase).toBe('ready')
    expect(memory.pendingWrites()).toBe(0)
  })

  test('cancel and settled do nothing when no download runs', async () => {
    const { service, dictionaryBytes } = setup()
    await service.cancel('dictionary')
    await service.settled('dictionary')
    expect((await service.status()).dictionary).toEqual(idle(dictionaryBytes))
  })
})

describe('remove', () => {
  test('deletes the bundle files only, and the bundle can be downloaded again', async () => {
    const { service, store, modelBytes, dictionaryBytes } = setup()
    await install(service, 'model')
    await install(service, 'dictionary')
    await service.remove('model')
    const status = await service.status()
    expect(status.model).toEqual(idle(modelBytes))
    expect(status.dictionary.phase).toBe('ready')
    expect((await store.list()).map(file => file.name)).toEqual(['wiktionary-test.pack'])
    expect(await service.open('model.onnx')).toBeUndefined()
    await install(service, 'model')
    expect((await service.status()).model.phase).toBe('ready')
    expect(dictionaryBytes).toBeGreaterThan(0)
  })

  test('cancels a running download first and clears its error', async () => {
    const { service, store, dictionaryBytes } = setup({ override: () => new Response(body(new Uint8Array(100), { after: 'hang' })) })
    await service.startDownload('dictionary', dictionaryBytes)
    await service.remove('dictionary')
    expect((await service.status()).dictionary).toEqual(idle(dictionaryBytes))
    expect(store.pendingWrites()).toBe(0)
  })
})

describe('open and verification', () => {
  test('open refuses names outside the manifest and files of a bundle that is not complete', async () => {
    const { service, store, metadata } = setup()
    store.files.set('model_metadata.json', metadata.transfer)
    store.files.set('stray.bin', new Uint8Array(3))
    expect(await service.open('stray.bin')).toBeUndefined()
    expect(await service.open('model_metadata.json')).toBeUndefined()
    expect(await service.open('../model_metadata.json')).toBeUndefined()
  })

  test('a stored file with the wrong size is removed and the bundle shows as missing', async () => {
    const { service, store, pack, dictionaryBytes, calls } = setup()
    await install(service, 'dictionary')
    store.files.set('wiktionary-test.pack', pack.transfer.slice(0, 100))
    expect((await service.status()).dictionary).toEqual(idle(dictionaryBytes))
    expect(await store.list()).toEqual([])
    await install(service, 'dictionary')
    expect(await read(service, 'wiktionary-test.pack')).toEqual(pack.transfer)
    expect(calls).toHaveLength(2)
  })

  test('a tampered file of the same size is found on first use in a session, removed and downloaded again', async () => {
    const first = setup()
    await install(first.service, 'dictionary')
    const tampered = first.pack.transfer.slice()
    tampered[10] = tampered[10]! ^ 1
    first.store.files.set('wiktionary-test.pack', tampered)
    // The session that downloaded it already hashed it.
    expect(await read(first.service, 'wiktionary-test.pack')).toEqual(tampered)

    const next = setup({ store: first.store })
    expect((await next.service.status()).dictionary.phase).toBe('ready')
    expect(await next.service.open('wiktionary-test.pack')).toBeUndefined()
    expect((await next.service.status()).dictionary).toEqual(idle(next.dictionaryBytes))
    await install(next.service, 'dictionary')
    expect(await read(next.service, 'wiktionary-test.pack')).toEqual(first.pack.transfer)
  })

  test('a file is hashed at most once per session', async () => {
    const first = setup()
    await install(first.service, 'dictionary')
    let reads = 0
    const store: FileStore = {
      open: async name => { const source = await first.store.open(name); return source && { size: source.size, read: (a, b) => { reads++; return source.read(a, b) } } },
      create: name => first.store.create(name), remove: name => first.store.remove(name), list: () => first.store.list(),
    }
    const service = new LocalAssetService({ store, manifest: first.manifest, fetch: first.fetch, hashChunkBytes: 1024 })
    await Promise.all([service.open('wiktionary-test.pack'), service.open('wiktionary-test.pack')])
    const afterFirst = reads
    expect(afterFirst).toBe(Math.ceil(first.pack.file.storedSize / 1024))
    await service.open('wiktionary-test.pack')
    expect(reads).toBe(afterFirst)
  })

  test('verify re-hashes a bundle on request, as after a failed model load, and removes what no longer matches', async () => {
    const { service, store, tokenizer, onnx, metadata } = setup()
    await install(service, 'model')
    expect(await service.verify('model')).toBe(true)
    const tampered = tokenizer.transfer.slice()
    tampered[0] = tampered[0]! ^ 1
    store.files.set('tokenizer.json', tampered)
    expect(await service.verify('model')).toBe(false)
    expect((await service.status()).model).toEqual(idle(tokenizer.file.size, { storedBytes: onnx.file.storedSize + metadata.file.storedSize }))
    expect(await service.verify('model')).toBe(false)
    await install(service, 'model')
    expect(await service.verify('model')).toBe(true)
  })

  test('a file that cannot be read while verifying counts as not matching', async () => {
    const first = setup()
    await install(first.service, 'dictionary')
    const store: FileStore = {
      open: async name => { const source = await first.store.open(name); return source && { size: source.size, read: () => Promise.reject(new Error('gone')) } },
      create: name => first.store.create(name), remove: name => first.store.remove(name), list: () => first.store.list(),
    }
    const service = new LocalAssetService({ store, manifest: first.manifest, fetch: first.fetch })
    expect(await service.open('wiktionary-test.pack')).toBeUndefined()
    expect((await service.status()).dictionary.phase).toBe('missing')
  })

  test('open returns nothing while its bundle is downloading', async () => {
    const first = setup()
    await install(first.service, 'model')
    await first.service.remove('model')
    first.store.files.set('model_metadata.json', first.metadata.transfer)
    const held = gate()
    const again = setup({ store: first.store, override: (_url, init) => abortable(init?.signal, held.promise.then(() => undefined as unknown as Response)) })
    const required = (await again.service.status()).model.requiredBytes
    await again.service.startDownload('model', required)
    expect(await again.service.open('model_metadata.json')).toBeUndefined()
    await again.service.cancel('model')
  })
})
