// A small in-memory stand-in for the parts of the File System Access API the
// OPFS store uses. Like Chrome, a writable writes to a swap copy and the file
// changes only on close(); move() renames within the parent directory.

const notFound = (name: string) => new DOMException(`${name} not found`, 'NotFoundError')

export class FakeFileHandle {
  readonly kind = 'file'
  data = new Uint8Array(0)
  lastWritable: FakeWritable | undefined
  constructor(public name: string, public parent: FakeDirectoryHandle) {}

  async getFile(): Promise<File> { return new File([this.data.slice()], this.name) }

  async createWritable(): Promise<FakeWritable> {
    this.lastWritable = new FakeWritable(this)
    return this.lastWritable
  }

  async move(name: string): Promise<void> {
    if (this.parent.entries_.has(name)) throw new DOMException('exists', 'InvalidModificationError')
    this.parent.entries_.delete(this.name)
    this.name = name
    this.parent.entries_.set(name, this)
  }
}

export class FakeWritable {
  private parts: Uint8Array[] = []
  state: 'open' | 'closed' | 'aborted' = 'open'
  /** Bytes after which write() throws QuotaExceededError. */
  quota = Infinity
  constructor(private readonly handle: FakeFileHandle) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== 'open') throw new TypeError('closed')
    const used = this.parts.reduce((sum, part) => sum + part.length, 0)
    if (used + chunk.length > this.quota) throw new DOMException('quota', 'QuotaExceededError')
    this.parts.push(chunk.slice())
  }

  async close(): Promise<void> {
    if (this.state !== 'open') throw new TypeError('closed')
    const out = new Uint8Array(this.parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of this.parts) { out.set(part, at); at += part.length }
    this.handle.data = out
    this.state = 'closed'
  }

  async abort(): Promise<void> { this.state = 'aborted' }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory'
  readonly entries_ = new Map<string, FakeFileHandle | FakeDirectoryHandle>()
  constructor(readonly name = '') {}

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const entry = this.entries_.get(name)
    if (entry instanceof FakeFileHandle) return entry
    if (entry) throw new DOMException('is a directory', 'TypeMismatchError')
    if (!options.create) throw notFound(name)
    const handle = new FakeFileHandle(name, this)
    this.entries_.set(name, handle)
    return handle
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectoryHandle> {
    const entry = this.entries_.get(name)
    if (entry instanceof FakeDirectoryHandle) return entry
    if (entry) throw new DOMException('is a file', 'TypeMismatchError')
    if (!options.create) throw notFound(name)
    const handle = new FakeDirectoryHandle(name)
    this.entries_.set(name, handle)
    return handle
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entries_.delete(name)) throw notFound(name)
  }

  async *entries(): AsyncIterableIterator<[string, FakeFileHandle | FakeDirectoryHandle]> {
    for (const entry of [...this.entries_]) yield entry
  }

  /** Test helper: puts a finished file in place directly. */
  put(name: string, data: Uint8Array): FakeFileHandle {
    const handle = new FakeFileHandle(name, this)
    handle.data = data.slice()
    this.entries_.set(name, handle)
    return handle
  }

  names(): string[] { return [...this.entries_.keys()].sort() }
}
