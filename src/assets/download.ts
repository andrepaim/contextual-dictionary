// One file's download into the private store. The transfer is hashed while
// it streams and refused as soon as it passes its pinned size; a gzip file
// is gunzipped on the way and the stored bytes are hashed and size-checked
// too. The file is committed only when every check passes, so a failure or
// a cancel never leaves a partial file behind.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { CodedError, type FileStore, type FileWriter } from '../shared/contracts'
import type { PinnedFile } from './manifest'

export type DownloadCode = 'DOWNLOAD_FAILED' | 'DOWNLOAD_STALLED' | 'DOWNLOAD_CANCELLED' | 'ASSET_CORRUPT' | 'ASSET_MISMATCH' | 'DISK_FULL' | 'INSTALL_FAILED'
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const DEFAULT_STALL_MS = 60_000

export interface DownloadOptions {
  url: string
  file: PinnedFile
  store: FileStore
  fetch: Fetch
  signal?: AbortSignal
  /** Give up when no bytes arrive for this long, waiting for the server included. */
  stallMs?: number
  /** Transfer bytes received so far. */
  onProgress?: (received: number) => void
}

const MESSAGES: Record<DownloadCode, string> = {
  DOWNLOAD_FAILED: 'The download failed.',
  DOWNLOAD_STALLED: 'The download stopped receiving data.',
  DOWNLOAD_CANCELLED: 'The download was cancelled.',
  ASSET_CORRUPT: 'The downloaded file does not match its published size and checksum.',
  ASSET_MISMATCH: 'The unpacked file does not match its pinned size and checksum.',
  DISK_FULL: 'There is not enough storage space.',
  INSTALL_FAILED: 'The file could not be saved.',
}
const coded = (code: DownloadCode) => new CodedError(code, MESSAGES[code])
const isQuota = (error: unknown) => (error as { name?: unknown } | null)?.name === 'QuotaExceededError'
/** A storage failure as a download code. */
const storageError = (error: unknown) => error instanceof CodedError ? error : coded(isQuota(error) ? 'DISK_FULL' : 'INSTALL_FAILED')

/** `promise`, or a rejection as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Checks the stored bytes against their pins and passes them to the writer. */
function storedSink(file: PinnedFile, writer: FileWriter) {
  const hash = sha256.create()
  let stored = 0
  return {
    async write(chunk: Uint8Array) {
      stored += chunk.length
      if (stored > file.storedSize) throw coded('ASSET_MISMATCH')
      hash.update(chunk)
      try { await writer.write(chunk) } catch (error) { throw storageError(error) }
    },
    finish() {
      if (stored !== file.storedSize || bytesToHex(hash.digest()) !== file.storedSha256) throw coded('ASSET_MISMATCH')
    },
  }
}

/**
 * Gunzips through DecompressionStream into `sink`. A gzip error is
 * ASSET_CORRUPT; an error of the sink is passed through as it is.
 */
function gunzip(sink: (chunk: Uint8Array) => Promise<void>) {
  const stream = new DecompressionStream('gzip')
  const input = stream.writable.getWriter()
  const output = stream.readable.getReader()
  let failure: CodedError | undefined
  const drained = (async () => {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try { step = await output.read() } catch { throw (failure ??= coded('ASSET_CORRUPT')) }
      if (step.done) return
      try { await sink(step.value) } catch (error) {
        failure ??= storageError(error)
        await output.cancel(failure).catch(() => {})
        throw failure
      }
    }
  })()
  drained.catch(() => {})
  // A write fails when the stream fails; the drain knows why.
  const settle = async (): Promise<never> => { await drained.catch(() => {}); throw failure ?? coded('ASSET_CORRUPT') }
  return {
    write: (chunk: Uint8Array) => input.write(chunk as Uint8Array<ArrayBuffer>).catch(settle),
    close: async () => { await input.close().catch(settle); await drained },
    abort: () => { input.abort().catch(() => {}); output.cancel().catch(() => {}) },
  }
}

/** Downloads `file` into `store` under its stored name; rejects with a CodedError. */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { file, store } = options
  const cancelled = options.signal ?? new AbortController().signal
  const stall = new AbortController()
  const signal = AbortSignal.any([cancelled, stall.signal])
  const reason = () => coded(cancelled.aborted ? 'DOWNLOAD_CANCELLED' : stall.signal.aborted ? 'DOWNLOAD_STALLED' : 'DOWNLOAD_FAILED')
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), options.stallMs ?? DEFAULT_STALL_MS) }

  if (cancelled.aborted) throw coded('DOWNLOAD_CANCELLED')
  let writer: FileWriter | undefined
  let inflate: ReturnType<typeof gunzip> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  arm()
  try {
    let response: Response
    try { response = await unlessAborted(options.fetch(options.url, { signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' }), signal) } catch { throw reason() }
    if (!response.ok || !response.body) {
      response.body?.cancel().catch(() => {})
      throw coded('DOWNLOAD_FAILED')
    }
    reader = response.body.getReader()
    try { writer = await store.create(file.storedName) } catch (error) { throw storageError(error) }
    const sink = storedSink(file, writer)
    if (file.encoding === 'gzip') inflate = gunzip(chunk => sink.write(chunk))
    const transferHash = sha256.create()
    let received = 0
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try { step = await unlessAborted(reader.read(), signal) } catch { throw reason() }
      if (step.done) break
      const chunk = step.value
      received += chunk.length
      if (received > file.size) throw coded('ASSET_CORRUPT')
      transferHash.update(chunk)
      arm()
      options.onProgress?.(received)
      await (inflate ? inflate.write(chunk) : sink.write(chunk))
    }
    clearTimeout(timer)
    if (received !== file.size || bytesToHex(transferHash.digest()) !== file.sha256) throw coded('ASSET_CORRUPT')
    await inflate?.close()
    sink.finish()
    if (cancelled.aborted) throw coded('DOWNLOAD_CANCELLED')
    const finished = writer
    writer = undefined
    try { await finished.commit() } catch (error) {
      await finished.abort().catch(() => {})
      throw storageError(error)
    }
  } catch (error) {
    inflate?.abort()
    reader?.cancel().catch(() => {})
    await writer?.abort().catch(() => {})
    throw error instanceof CodedError ? error : coded('INSTALL_FAILED')
  } finally {
    clearTimeout(timer)
  }
}
