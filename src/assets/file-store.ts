// The extension's private files. A write goes to a temporary name and is
// moved into place by commit(), so a file is visible to open() and list()
// only once it is complete. `OpfsFileStore` keeps the files in the origin
// private file system (an extension page or a worker); `MemoryFileStore`
// keeps them in memory for tests.

import { CodedError, type ByteSource, type FileStore, type FileWriter } from '../shared/contracts'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** A plain file name: no separators, no leading dot (temporary files start with one). */
export const isSafeName = (name: unknown): name is string => typeof name === 'string' && SAFE_NAME.test(name)

const TEMPORARY = '.tmp-'

function checkName(name: string): void {
  if (!isSafeName(name)) throw new CodedError('INVALID_NAME', `Not a safe file name: ${JSON.stringify(name)}`)
}

/** The range [start, end) clamped to a file of `size` bytes. */
function clamp(size: number, start: number, end: number): [number, number] {
  const from = Math.min(size, Math.max(0, Math.floor(start)))
  return [from, Math.max(from, Math.min(size, Math.floor(end)))]
}

const finished = () => Promise.reject(new Error('This writer is already committed or aborted.'))

// ------------------------------------------------------------------- memory

export class MemoryFileStore implements FileStore {
  /** Committed files by name. Tests may change them directly to simulate damage. */
  readonly files = new Map<string, Uint8Array>()
  private readonly pending = new Set<number>()
  private pendingBytes = new Map<number, number>()
  private next = 0

  /** `quotaBytes` makes writes past that many bytes (committed and pending) throw QuotaExceededError. */
  constructor(private readonly options: { quotaBytes?: number } = {}) {}

  /** Writers created and not yet committed or aborted. */
  pendingWrites(): number { return this.pending.size }

  async open(name: string): Promise<ByteSource | undefined> {
    const data = isSafeName(name) ? this.files.get(name) : undefined
    if (!data) return undefined
    return { size: data.length, read: async (start, end) => data.slice(...clamp(data.length, start, end)) }
  }

  async create(name: string): Promise<FileWriter> {
    checkName(name)
    const id = this.next++
    const parts: Uint8Array[] = []
    let state: 'open' | 'done' = 'open'
    this.pending.add(id)
    this.pendingBytes.set(id, 0)
    const release = () => { state = 'done'; this.pending.delete(id); this.pendingBytes.delete(id) }
    return {
      write: async chunk => {
        if (state !== 'open') return finished()
        const used = [...this.files.values()].reduce((sum, file) => sum + file.length, 0) + [...this.pendingBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
        if (used + chunk.length > (this.options.quotaBytes ?? Infinity)) throw new DOMException('The storage quota is exceeded.', 'QuotaExceededError')
        parts.push(chunk.slice())
        this.pendingBytes.set(id, (this.pendingBytes.get(id) ?? 0) + chunk.length)
      },
      commit: async () => {
        if (state !== 'open') return finished()
        const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
        let at = 0
        for (const part of parts) { data.set(part, at); at += part.length }
        release()
        this.files.set(name, data)
      },
      abort: async () => { if (state === 'open') release() },
    }
  }

  async remove(name: string): Promise<void> {
    checkName(name)
    this.files.delete(name)
  }

  async list(): Promise<Array<{ name: string; size: number }>> {
    return [...this.files].map(([name, data]) => ({ name, size: data.length })).sort((a, b) => a.name.localeCompare(b.name))
  }
}

// --------------------------------------------------------------------- OPFS

/** The parts of the File System Access API this store uses (Chrome 124+, windows and workers). */
export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export interface OpfsFileHandle {
  readonly kind: 'file'
  getFile(): Promise<Blob>
  createWritable(): Promise<OpfsWritable>
  move(name: string): Promise<void>
}
export interface OpfsDirectory {
  readonly kind: 'directory'
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>
  removeEntry(name: string): Promise<void>
  entries(): AsyncIterableIterator<[string, { readonly kind: 'file' | 'directory' }]>
}

const isNotFound = (error: unknown) => (error as { name?: unknown } | null)?.name === 'NotFoundError'

async function removeQuietly(directory: OpfsDirectory, name: string): Promise<void> {
  try { await directory.removeEntry(name) } catch { /* already gone or still locked; cleaned up on the next start */ }
}

export interface OpfsOptions {
  /** The origin private file system root; defaults to navigator.storage.getDirectory(). */
  root?: OpfsDirectory
  /** The subdirectory holding the files. */
  directory?: string
  /**
   * Remove leftovers of interrupted writes. Only the context that owns the
   * downloads (the offscreen document) should do this; a reader opening the
   * same store passes false so it never removes a write in progress.
   */
  cleanup?: boolean
}

export class OpfsFileStore implements FileStore {
  private constructor(private readonly directory: OpfsDirectory) {}

  static async open(options: OpfsOptions = {}): Promise<OpfsFileStore> {
    const root = options.root ?? (await navigator.storage.getDirectory() as unknown as OpfsDirectory)
    const directory = await root.getDirectoryHandle(options.directory ?? 'assets', { create: true })
    if (options.cleanup ?? true) {
      const leftovers: string[] = []
      for await (const [name] of directory.entries()) if (name.startsWith(TEMPORARY)) leftovers.push(name)
      for (const name of leftovers) await removeQuietly(directory, name)
    }
    return new OpfsFileStore(directory)
  }

  async open(name: string): Promise<ByteSource | undefined> {
    if (!isSafeName(name)) return undefined
    let file: Blob
    try { file = await (await this.directory.getFileHandle(name)).getFile() } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    return {
      size: file.size,
      read: async (start, end) => new Uint8Array(await file.slice(...clamp(file.size, start, end)).arrayBuffer()),
    }
  }

  async create(name: string): Promise<FileWriter> {
    checkName(name)
    const temporary = `${TEMPORARY}${crypto.randomUUID()}`
    const handle = await this.directory.getFileHandle(temporary, { create: true })
    let writable: OpfsWritable
    try { writable = await handle.createWritable() } catch (error) {
      await removeQuietly(this.directory, temporary)
      throw error
    }
    let state: 'open' | 'done' = 'open'
    return {
      write: chunk => state === 'open' ? writable.write(chunk) : finished(),
      commit: async () => {
        if (state !== 'open') return finished()
        state = 'done'
        try {
          await writable.close()
          await this.remove(name)
          await handle.move(name)
        } catch (error) {
          await removeQuietly(this.directory, temporary)
          throw error
        }
      },
      abort: async () => {
        if (state !== 'open') return
        state = 'done'
        try { await writable.abort() } catch { /* already closed */ }
        await removeQuietly(this.directory, temporary)
      },
    }
  }

  async remove(name: string): Promise<void> {
    checkName(name)
    try { await this.directory.removeEntry(name) } catch (error) { if (!isNotFound(error)) throw error }
  }

  async list(): Promise<Array<{ name: string; size: number }>> {
    const files: Array<{ name: string; size: number }> = []
    for await (const [name, entry] of this.directory.entries()) {
      if (entry.kind !== 'file' || !isSafeName(name)) continue
      try { files.push({ name, size: (await (entry as OpfsFileHandle).getFile()).size }) } catch (error) { if (!isNotFound(error)) throw error }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name))
  }
}
