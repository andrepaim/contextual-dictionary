import { describe, expect, test } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { FileStore, FileWriter } from '../../../src/shared/contracts'
import { downloadFile, DEFAULT_STALL_MS, type DownloadOptions } from '../../../src/assets/download'
import { MemoryFileStore } from '../../../src/assets/file-store'
import type { PinnedFile } from '../../../src/assets/manifest'
import { abortable, body, bytes, gate, gzipFile, identityFile, sha, text } from './helpers'

const URL = 'https://assets.test/file'

function setup(file: PinnedFile, respond: (init: RequestInit | undefined) => Response | Promise<Response>, extra: Partial<DownloadOptions> = {}) {
  const store = new MemoryFileStore()
  const progress: number[] = []
  const calls: Array<RequestInit | undefined> = []
  const options: DownloadOptions = {
    url: URL, file, store,
    fetch: async (_url, init) => { calls.push(init); return respond(init) },
    onProgress: received => progress.push(received),
    ...extra,
  }
  return { store, progress, calls, run: () => downloadFile(options) }
}

const respondWith = (data: Uint8Array, chunk = 1000) => () => new Response(body(data, { chunk }))

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

/** Nothing of the file is visible and no write is left open. */
async function expectNothing(store: MemoryFileStore) {
  expect(await store.list()).toEqual([])
  expect(store.pendingWrites()).toBe(0)
}

describe('a plain file', () => {
  const { file, transfer } = identityFile('plain.bin', bytes(4500))

  test('streams into the store with progress and is committed once verified', async () => {
    const { store, progress, calls, run } = setup(file, respondWith(transfer))
    await run()
    expect(progress).toEqual([1000, 2000, 3000, 4000, 4500])
    expect(calls[0]).toMatchObject({ redirect: 'follow', credentials: 'omit', cache: 'no-store' })
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(store.files.get('plain.bin')).toEqual(transfer)
    expect(store.pendingWrites()).toBe(0)
  })

  test('a truncated transfer is refused as corrupt', async () => {
    const { store, run } = setup(file, respondWith(transfer.slice(0, 4000)))
    await expectCode(run(), 'ASSET_CORRUPT')
    await expectNothing(store)
  })

  test('an oversized transfer is refused as soon as it passes the pinned size', async () => {
    const big = new Uint8Array(20_000)
    big.set(transfer)
    const { store, progress, run } = setup(file, respondWith(big))
    await expectCode(run(), 'ASSET_CORRUPT')
    expect(Math.max(...progress)).toBeLessThanOrEqual(file.size)
    await expectNothing(store)
  })

  test('a transfer with the right size but other bytes is refused as corrupt', async () => {
    const altered = transfer.slice()
    altered[100] = altered[100]! ^ 1
    const { store, run } = setup(file, respondWith(altered))
    await expectCode(run(), 'ASSET_CORRUPT')
    await expectNothing(store)
  })

  test('an HTTP error, a missing body or a network error fails the download', async () => {
    for (const respond of [
      () => new Response('nope', { status: 404 }),
      () => new Response('down', { status: 503 }),
      () => new Response(null, { status: 200 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => new Response(body(transfer.slice(0, 2000), { after: 'error' })),
    ]) {
      const { store, run } = setup(file, respond)
      await expectCode(run(), 'DOWNLOAD_FAILED')
      await expectNothing(store)
    }
  })

  test('a transfer that stops sending stalls after the stall time', async () => {
    const { store, progress, run } = setup(file, () => new Response(body(transfer.slice(0, 2000), { chunk: 1000, after: 'hang' })), { stallMs: 30 })
    await expectCode(run(), 'DOWNLOAD_STALLED')
    expect(progress).toEqual([1000, 2000])
    await expectNothing(store)
  })

  test('a server that never answers stalls too', async () => {
    const { store, run } = setup(file, init => abortable(init?.signal, new Promise<Response>(() => {})), { stallMs: 30 })
    await expectCode(run(), 'DOWNLOAD_STALLED')
    await expectNothing(store)
  })

  test('a slow but steady transfer does not stall', async () => {
    let at = 0
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 15))
        if (at >= transfer.length) return controller.close()
        controller.enqueue(transfer.slice(at, at + 1000))
        at += 1000
      },
    }, { highWaterMark: 0 })
    const { store, run } = setup(file, () => new Response(slow), { stallMs: 40 })
    await run()
    expect(store.files.get('plain.bin')).toEqual(transfer)
  })

  test('the default stall time is one minute', () => {
    expect(DEFAULT_STALL_MS).toBe(60_000)
  })

  test('cancelling while waiting for the server, during the transfer or during a write stops cleanly', async () => {
    // Waiting for headers.
    const waiting = new AbortController()
    const first = setup(file, init => abortable(init?.signal, new Promise<Response>(() => {})), { signal: waiting.signal })
    const pending = first.run()
    setTimeout(() => waiting.abort(), 5)
    await expectCode(pending, 'DOWNLOAD_CANCELLED')
    await expectNothing(first.store)

    // During the transfer: the body hangs after two chunks.
    const transferring = new AbortController()
    const second = setup(file, () => new Response(body(transfer, { chunk: 1000, after: 'hang' })), {
      signal: transferring.signal, onProgress: received => { if (received === 2000) transferring.abort() },
    })
    await expectCode(second.run(), 'DOWNLOAD_CANCELLED')
    await expectNothing(second.store)

    // Already cancelled before it starts.
    const early = new AbortController()
    early.abort()
    const third = setup(file, respondWith(transfer), { signal: early.signal })
    await expectCode(third.run(), 'DOWNLOAD_CANCELLED')
    expect(third.calls).toHaveLength(0)
    await expectNothing(third.store)
  })

  test('cancelling while the last bytes are written prevents the commit', async () => {
    const controller = new AbortController()
    const held = gate()
    const memory = new MemoryFileStore()
    let writes = 0
    const store: FileStore = {
      ...bind(memory),
      create: async name => {
        const writer = await memory.create(name)
        return { ...bindWriter(writer), write: async chunk => { writes++; if (writes === 5) { controller.abort(); await held.promise } return writer.write(chunk) } }
      },
    }
    const run = downloadFile({ url: URL, file, store, fetch: async () => new Response(body(transfer, { chunk: 1000 })), signal: controller.signal })
    setTimeout(() => held.open(), 10)
    await expectCode(run, 'DOWNLOAD_CANCELLED')
    await expectNothing(memory)
  })

  test('a full disk is reported as DISK_FULL, while writing or when committing', async () => {
    const small = new MemoryFileStore({ quotaBytes: 3000 })
    await expectCode(downloadFile({ url: URL, file, store: small, fetch: async () => new Response(body(transfer)) }), 'DISK_FULL')
    await expectNothing(small)

    const memory = new MemoryFileStore()
    const failCommit: FileStore = {
      ...bind(memory),
      create: async name => ({ ...bindWriter(await memory.create(name)), commit: () => Promise.reject(new DOMException('full', 'QuotaExceededError')) }),
    }
    await expectCode(downloadFile({ url: URL, file, store: failCommit, fetch: async () => new Response(body(transfer)) }), 'DISK_FULL')
    await expectNothing(memory)
  })

  test('any other storage failure is INSTALL_FAILED', async () => {
    const memory = new MemoryFileStore()
    const failing: FileStore[] = [
      { ...bind(memory), create: () => Promise.reject(new Error('no directory')) },
      { ...bind(memory), create: async name => ({ ...bindWriter(await memory.create(name)), write: () => Promise.reject(new Error('io')) }) },
      { ...bind(memory), create: async name => ({ ...bindWriter(await memory.create(name)), commit: () => Promise.reject(new Error('move failed')) }) },
    ]
    for (const store of failing) {
      await expectCode(downloadFile({ url: URL, file, store, fetch: async () => new Response(body(transfer)) }), 'INSTALL_FAILED')
      await expectNothing(memory)
    }
  })
})

describe('a gzip file', () => {
  // Text compresses and random bytes do not, so the transfer is smaller than the stored file but not tiny.
  const stored = new Uint8Array([...text(30_000), ...bytes(5_000, 9)])
  const { file, transfer } = gzipFile('big.txt.gz', 'big.txt', stored)

  test('is gunzipped while it streams and stored in its pinned form', async () => {
    expect(transfer.length).toBeLessThan(stored.length)
    const { store, progress, run } = setup(file, respondWith(transfer, 100))
    await run()
    expect(store.files.get('big.txt')).toEqual(stored)
    expect(store.files.has('big.txt.gz')).toBe(false)
    expect(progress.at(-1)).toBe(transfer.length)
  })

  test('a stored form that differs from its pins is refused as a mismatch', async () => {
    const other = gzipFile('big.txt.gz', 'big.txt', new Uint8Array([...text(30_000, 'sense '), ...bytes(5_000, 9)]))
    const wrongDigest: PinnedFile = { ...other.file, storedSha256: file.storedSha256 }
    const first = setup(wrongDigest, respondWith(other.transfer))
    await expectCode(first.run(), 'ASSET_MISMATCH')
    await expectNothing(first.store)

    const wrongSize: PinnedFile = { ...file, storedSize: stored.length - 1 }
    const second = setup(wrongSize, respondWith(transfer))
    await expectCode(second.run(), 'ASSET_MISMATCH')
    await expectNothing(second.store)

    const tooShort: PinnedFile = { ...file, storedSize: stored.length + 1 }
    const third = setup(tooShort, respondWith(transfer))
    await expectCode(third.run(), 'ASSET_MISMATCH')
    await expectNothing(third.store)
  })

  test('a gzip stream whose checksum fails is refused as corrupt', async () => {
    const broken = transfer.slice()
    broken[broken.length - 8] = broken[broken.length - 8]! ^ 0xff
    const pinned: PinnedFile = { ...file, sha256: sha(broken) }
    const { store, run } = setup(pinned, respondWith(broken, 100))
    await expectCode(run(), 'ASSET_CORRUPT')
    await expectNothing(store)
  })

  test('bytes that are not gzip at all are refused as corrupt', async () => {
    const plain = bytes(500)
    const pinned: PinnedFile = { ...file, size: plain.length, sha256: sha(plain) }
    const { store, run } = setup(pinned, respondWith(plain, 100))
    await expectCode(run(), 'ASSET_CORRUPT')
    await expectNothing(store)
  })

  test('a gzip bomb stops once the stored size is passed', async () => {
    const bomb = new Uint8Array(gzipSync(new Uint8Array(5_000_000)))
    const pinned: PinnedFile = { ...file, size: bomb.length, sha256: sha(bomb), storedSize: 1000 }
    const { store, run } = setup(pinned, respondWith(bomb, 100))
    await expectCode(run(), 'ASSET_MISMATCH')
    await expectNothing(store)
  })

  test('a full disk while gunzipping is DISK_FULL', async () => {
    const store = new MemoryFileStore({ quotaBytes: 20_000 })
    await expectCode(downloadFile({ url: URL, file, store, fetch: async () => new Response(body(transfer, { chunk: 100 })) }), 'DISK_FULL')
    await expectNothing(store)
  })

  test('cancelling during the transfer of a gzip file stops cleanly', async () => {
    const controller = new AbortController()
    const { store, run } = setup(file, () => new Response(body(transfer, { chunk: 100, after: 'hang' })), {
      signal: controller.signal, onProgress: received => { if (received >= 1000) controller.abort() },
    })
    await expectCode(run(), 'DOWNLOAD_CANCELLED')
    await expectNothing(store)
  })
})

// Spreading a class instance drops its prototype methods; these keep them bound.
function bind(store: MemoryFileStore): FileStore {
  return { open: name => store.open(name), create: name => store.create(name), remove: name => store.remove(name), list: () => store.list() }
}
function bindWriter(writer: FileWriter): FileWriter {
  return { write: chunk => writer.write(chunk), commit: () => writer.commit(), abort: () => writer.abort() }
}
