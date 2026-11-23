// The asset service: what is installed, the confirmed downloads, cancel,
// remove, and verified access to installed files.
//
// A file counts as installed when the store holds it with its pinned stored
// size; anything else under that name is removed so it can be downloaded
// again. Its full SHA-256 is checked once per session, in the background
// after its first open (files downloaded in this session were hashed while
// they arrived), so a lookup never waits for a whole file to be hashed; and
// again on request through verify(), for example after the model failed to
// load. A file that no longer matches is removed, so its bundle shows as
// missing, and onInvalid listeners hear of it so they can let go of what
// they opened. Until then a damaged file can at worst fail a lookup: the
// pack's blocks are gzip-checked when read, and a model that fails to load
// is verified again.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { CodedError, type AssetService, type BundleName, type BundleStatus, type ByteSource, type FileStore } from '../shared/contracts'
import { DEFAULT_STALL_MS, downloadFile, type Fetch } from './download'
import { ASSET_MANIFEST, BUNDLE_NAMES, assertManifest, fileUrl, isPinned, publishedFiles, type AssetManifest, type ManifestFile, type PinnedFile } from './manifest'

export interface AssetServiceOptions {
  store: FileStore
  /** Defaults to the pinned ASSET_MANIFEST; tests and end-to-end runs point it at a local server. */
  manifest?: AssetManifest
  /** Defaults to the global fetch. */
  fetch?: Fetch
  stallMs?: number
  /** Bytes read at a time while hashing a stored file. */
  hashChunkBytes?: number
}

type Job = {
  controller: AbortController
  phase: 'downloading' | 'installing'
  received: number
  total: number
  done: Promise<void>
}

type Inspection = { present: Set<string>; storedBytes: number; missing: ManifestFile[] }

export class LocalAssetService implements AssetService {
  private readonly manifest: AssetManifest
  private readonly store: FileStore
  private readonly fetch: Fetch
  private readonly stallMs: number
  private readonly hashChunkBytes: number
  private readonly jobs = new Map<BundleName, Job>()
  private readonly errors = new Map<BundleName, string>()
  /** Serialises startDownload per bundle, so concurrent calls see each other's job. */
  private readonly starting = new Map<BundleName, Promise<unknown>>()
  /** Stored names whose content was hashed this session, or is being hashed. */
  private readonly verified = new Map<string, Promise<boolean>>()
  /** Background checks still running. */
  private readonly checking = new Set<Promise<unknown>>()
  private readonly invalidListeners = new Set<(bundle: BundleName) => void>()

  constructor(options: AssetServiceOptions) {
    this.manifest = assertManifest(options.manifest ?? ASSET_MANIFEST)
    this.store = options.store
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS
    this.hashChunkBytes = options.hashChunkBytes ?? 8 * 1024 * 1024
  }

  async status(): Promise<Record<BundleName, BundleStatus>> {
    const listing = await this.listing()
    const out = {} as Record<BundleName, BundleStatus>
    for (const bundle of BUNDLE_NAMES) out[bundle] = this.describe(bundle, await this.inspect(bundle, listing))
    return out
  }

  async startDownload(bundle: BundleName, acceptBytes: number): Promise<void> {
    const previous = this.starting.get(bundle) ?? Promise.resolve()
    const attempt = previous.catch(() => {}).then(() => this.start(bundle, acceptBytes))
    this.starting.set(bundle, attempt)
    try { await attempt } finally { if (this.starting.get(bundle) === attempt) this.starting.delete(bundle) }
  }

  async cancel(bundle: BundleName): Promise<void> {
    const job = this.jobs.get(bundle)
    if (!job) return
    job.controller.abort()
    await job.done
  }

  async remove(bundle: BundleName): Promise<void> {
    await this.cancel(bundle)
    for (const file of this.manifest.bundles[bundle]) {
      this.verified.delete(file.storedName)
      await this.store.remove(file.storedName)
    }
    this.errors.delete(bundle)
  }

  async open(storedName: string): Promise<ByteSource | undefined> {
    const bundle = this.bundleOf(storedName)
    if (!bundle || this.jobs.has(bundle)) return undefined
    const { missing } = await this.inspect(bundle, await this.listing())
    if (missing.length) return undefined
    const file = this.manifest.bundles[bundle].find(entry => entry.storedName === storedName) as PinnedFile
    const known = this.verified.get(storedName)
    if (!known) this.checkInBackground(bundle, file)
    return this.store.open(storedName)
  }

  /** Calls `listener` with the bundle whenever a background check finds a file that no longer matches (and removed it). Returns a function that stops it. */
  onInvalid(listener: (bundle: BundleName) => void): () => void {
    this.invalidListeners.add(listener)
    return () => { this.invalidListeners.delete(listener) }
  }

  /** Resolves once the background checks started so far have finished. */
  async checked(): Promise<void> {
    while (this.checking.size) await Promise.allSettled([...this.checking])
  }

  /** Hashes every installed file of `bundle` again; false when any is missing or no longer matches (and was removed). */
  async verify(bundle: BundleName): Promise<boolean> {
    if (this.jobs.has(bundle)) return false
    const { missing, present } = await this.inspect(bundle, await this.listing())
    let ok = missing.length === 0
    for (const file of this.manifest.bundles[bundle]) {
      if (!present.has(file.storedName)) continue
      if (!(await this.check(file as PinnedFile, true))) ok = false
    }
    return ok
  }

  /** Resolves when the bundle's current download, if any, has finished. */
  async settled(bundle: BundleName): Promise<void> {
    await this.starting.get(bundle)?.catch(() => {})
    await this.jobs.get(bundle)?.done
  }

  // ---------------------------------------------------------------- internals

  private bundleOf(storedName: string): BundleName | undefined {
    return BUNDLE_NAMES.find(bundle => this.manifest.bundles[bundle].some(file => file.storedName === storedName))
  }

  private async listing(): Promise<Map<string, number>> {
    return new Map((await this.store.list()).map(file => [file.name, file.size]))
  }

  /** Which files of `bundle` are present; a stored file of the wrong size is removed. */
  private async inspect(bundle: BundleName, listing: Map<string, number>): Promise<Inspection> {
    const present = new Set<string>()
    const missing: ManifestFile[] = []
    let storedBytes = 0
    for (const file of this.manifest.bundles[bundle]) {
      const size = listing.get(file.storedName)
      if (size !== undefined && isPinned(file) && size === file.storedSize) {
        present.add(file.storedName)
        storedBytes += size
        continue
      }
      // Leave a bundle that is downloading alone; its files are only committed once verified.
      if (size !== undefined && isPinned(file) && !this.jobs.has(bundle)) {
        this.verified.delete(file.storedName)
        await this.store.remove(file.storedName)
      } else if (size !== undefined) storedBytes += size
      missing.push(file)
    }
    return { present, storedBytes, missing }
  }

  private describe(bundle: BundleName, { missing, storedBytes }: Inspection): BundleStatus {
    const job = this.jobs.get(bundle)
    const published = publishedFiles(this.manifest, bundle) !== undefined
    const requiredBytes = published ? missing.reduce((sum, file) => sum + (file.size ?? 0), 0) : 0
    const error = this.errors.get(bundle) ?? (published || missing.length === 0 ? null : 'DOWNLOAD_UNAVAILABLE')
    const phase = job ? job.phase : missing.length === 0 ? 'ready' : this.errors.has(bundle) ? 'failed' : 'missing'
    return { phase, error: phase === 'ready' ? null : error, requiredBytes, receivedBytes: job?.received ?? 0, totalBytes: job?.total ?? 0, storedBytes }
  }

  private async start(bundle: BundleName, acceptBytes: number): Promise<void> {
    if (this.jobs.has(bundle)) return
    if (!publishedFiles(this.manifest, bundle)) throw new CodedError('DOWNLOAD_UNAVAILABLE', 'These files are not published for this version.')
    const { missing } = await this.inspect(bundle, await this.listing())
    const files = missing as PinnedFile[]
    const requiredBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (acceptBytes !== requiredBytes) throw new CodedError('DOWNLOAD_SIZE_CHANGED', 'The download size changed. Review it and confirm again.', { requiredBytes })
    this.errors.delete(bundle)
    if (!files.length) return
    const job: Job = { controller: new AbortController(), phase: 'downloading', received: 0, total: requiredBytes, done: Promise.resolve() }
    this.jobs.set(bundle, job)
    job.done = this.run(bundle, job, files)
  }

  private async run(bundle: BundleName, job: Job, files: PinnedFile[]): Promise<void> {
    let done = 0
    try {
      for (const file of files) {
        await downloadFile({
          url: fileUrl(this.manifest, file), file, store: this.store, fetch: this.fetch, signal: job.controller.signal, stallMs: this.stallMs,
          onProgress: received => {
            job.received = done + received
            if (job.received >= job.total) job.phase = 'installing'
          },
        })
        // Hashed while it arrived; no need to hash it again this session.
        this.verified.set(file.storedName, Promise.resolve(true))
        done += file.size
        job.received = done
      }
    } catch (error) {
      const code = error instanceof CodedError ? error.code : 'INSTALL_FAILED'
      if (code === 'DOWNLOAD_CANCELLED') this.errors.delete(bundle)
      else this.errors.set(bundle, code)
    } finally {
      this.jobs.delete(bundle)
    }
  }

  private checkInBackground(bundle: BundleName, file: PinnedFile): void {
    const task = this.check(file, false).then(ok => {
      if (ok) return
      for (const listener of [...this.invalidListeners]) {
        try { listener(bundle) } catch { /* a listener's problem is its own */ }
      }
    }).finally(() => this.checking.delete(task))
    this.checking.add(task)
  }

  /** Whether the stored file matches its digest; a file that does not is removed. Hashes once per session unless `again`. */
  private check(file: PinnedFile, again: boolean): Promise<boolean> {
    const known = this.verified.get(file.storedName)
    if (known && !again) return known
    const result = this.hash(file).then(async ok => {
      if (!ok) {
        await this.store.remove(file.storedName).catch(() => {})
        if (this.verified.get(file.storedName) === result) this.verified.delete(file.storedName)
      }
      return ok
    })
    this.verified.set(file.storedName, result)
    return result
  }

  private async hash(file: PinnedFile): Promise<boolean> {
    try {
      const source = await this.store.open(file.storedName)
      if (!source || source.size !== file.storedSize) return false
      const hash = sha256.create()
      for (let at = 0; at < source.size; at += this.hashChunkBytes) hash.update(await source.read(at, Math.min(source.size, at + this.hashChunkBytes)))
      return bytesToHex(hash.digest()) === file.storedSha256
    } catch { return false }
  }
}

/** The asset service over `options.store`, downloading the pinned release by default. */
export const createAssetService = (options: AssetServiceOptions): LocalAssetService => new LocalAssetService(options)
