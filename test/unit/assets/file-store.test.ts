import { describe, expect, test, vi } from 'vitest'
import type { FileStore } from '../../../src/shared/contracts'
import { MemoryFileStore, OpfsFileStore, isSafeName, type OpfsDirectory } from '../../../src/assets/file-store'
import { FakeDirectoryHandle } from './fake-opfs'
import { bytes } from './helpers'

const encode = (value: string) => new TextEncoder().encode(value)

/** Behaviour every FileStore shares, run against both implementations. */
function contract(name: string, make: () => Promise<FileStore>) {
  describe(`${name} (FileStore contract)`, () => {
    test('a file appears only once committed, and reads back by range', async () => {
      const store = await make()
      const writer = await store.create('a.bin')
      await writer.write(encode('hello '))
      await writer.write(encode('world'))
      expect(await store.open('a.bin')).toBeUndefined()
      expect(await store.list()).toEqual([])
      await writer.commit()
      expect(await store.list()).toEqual([{ name: 'a.bin', size: 11 }])
      const source = (await store.open('a.bin'))!
      expect(source.size).toBe(11)
      expect(new TextDecoder().decode(await source.read(0, 5))).toBe('hello')
      expect(new TextDecoder().decode(await source.read(6, 11))).toBe('world')
      expect(new TextDecoder().decode(await source.read(6, 100))).toBe('world')
      expect((await source.read(-3, 2)).length).toBe(2)
      expect((await source.read(8, 4)).length).toBe(0)
    })

    test('an aborted write leaves nothing, and a commit replaces an older copy', async () => {
      const store = await make()
      const first = await store.create('b.bin')
      await first.write(encode('one'))
      await first.commit()
      const aborted = await store.create('b.bin')
      await aborted.write(encode('partial'))
      await aborted.abort()
      expect(await store.list()).toEqual([{ name: 'b.bin', size: 3 }])
      const second = await store.create('b.bin')
      await second.write(encode('second'))
      await second.commit()
      expect(await store.list()).toEqual([{ name: 'b.bin', size: 6 }])
      expect(new TextDecoder().decode(await (await store.open('b.bin'))!.read(0, 6))).toBe('second')
    })

    test('remove deletes a file and ignores a missing one', async () => {
      const store = await make()
      const writer = await store.create('c.bin')
      await writer.write(bytes(10))
      await writer.commit()
      await store.remove('c.bin')
      await store.remove('c.bin')
      expect(await store.open('c.bin')).toBeUndefined()
      expect(await store.list()).toEqual([])
    })

    test('refuses unsafe names', async () => {
      const store = await make()
      for (const bad of ['', '.tmp-x', '../x', 'a/b']) {
        await expect(store.create(bad)).rejects.toMatchObject({ code: 'INVALID_NAME' })
        expect(await store.open(bad)).toBeUndefined()
        await expect(store.remove(bad)).rejects.toMatchObject({ code: 'INVALID_NAME' })
      }
    })

    test('a writer cannot be used after it is finished', async () => {
      const store = await make()
      const writer = await store.create('d.bin')
      await writer.commit()
      await expect(writer.write(encode('late'))).rejects.toThrow()
      await expect(writer.commit()).rejects.toThrow()
      await writer.abort()
      expect(await store.list()).toEqual([{ name: 'd.bin', size: 0 }])
    })
  })
}

contract('MemoryFileStore', async () => new MemoryFileStore())
contract('OpfsFileStore', async () => OpfsFileStore.open({ root: new FakeDirectoryHandle() as unknown as OpfsDirectory }))

test('isSafeName accepts plain file names only', () => {
  for (const name of ['a', 'model.onnx', 'tokenizer_config.json', 'wiktionary-en-v1.pack']) expect(isSafeName(name), name).toBe(true)
  for (const name of ['', '.x', '-x', 'a/b', 'a\\b', 'a:b', 'a b', 'x'.repeat(129), 7, null]) expect(isSafeName(name), String(name)).toBe(false)
})

describe('MemoryFileStore', () => {
  test('throws QuotaExceededError past its quota and keeps nothing of that write', async () => {
    const store = new MemoryFileStore({ quotaBytes: 100 })
    const writer = await store.create('big.bin')
    await writer.write(bytes(60))
    await expect(writer.write(bytes(60))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await writer.abort()
    expect(await store.list()).toEqual([])
    expect(store.pendingWrites()).toBe(0)
  })

  test('exposes committed bytes so tests can alter them', async () => {
    const store = new MemoryFileStore()
    store.files.set('x.bin', bytes(4))
    expect(await store.list()).toEqual([{ name: 'x.bin', size: 4 }])
    const writer = await store.create('y.bin')
    expect(store.pendingWrites()).toBe(1)
    await writer.abort()
    expect(store.pendingWrites()).toBe(0)
  })
})

describe('OpfsFileStore', () => {
  test('keeps its files in a subdirectory of the origin private file system', async () => {
    const root = new FakeDirectoryHandle()
    const store = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory })
    const writer = await store.create('a.bin')
    await writer.write(bytes(5))
    expect((await root.getDirectoryHandle('assets')).names()).toHaveLength(1)
    expect((await root.getDirectoryHandle('assets')).names()[0]).toMatch(/^\./)
    await writer.commit()
    expect((await root.getDirectoryHandle('assets')).names()).toEqual(['a.bin'])
    const other = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory, directory: 'elsewhere' })
    expect(await other.list()).toEqual([])
  })

  test('removes leftovers of an interrupted write when it opens, and ignores directories', async () => {
    const root = new FakeDirectoryHandle()
    const directory = await root.getDirectoryHandle('assets', { create: true })
    directory.put('.tmp-crashed', bytes(50))
    directory.put('kept.bin', bytes(7))
    await directory.getDirectoryHandle('nested', { create: true })
    const store = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory })
    expect(directory.names()).toEqual(['kept.bin', 'nested'])
    expect(await store.list()).toEqual([{ name: 'kept.bin', size: 7 }])
  })

  test('leaves leftovers alone when asked to', async () => {
    const root = new FakeDirectoryHandle()
    const directory = await root.getDirectoryHandle('assets', { create: true })
    directory.put('.tmp-busy', bytes(5))
    await OpfsFileStore.open({ root: root as unknown as OpfsDirectory, cleanup: false })
    expect(directory.names()).toEqual(['.tmp-busy'])
  })

  test('an aborted or failed commit removes its temporary file', async () => {
    const root = new FakeDirectoryHandle()
    const store = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory })
    const directory = await root.getDirectoryHandle('assets')
    const writer = await store.create('a.bin')
    await writer.write(bytes(5))
    await writer.abort()
    expect(directory.names()).toEqual([])

    const failing = await store.create('b.bin')
    await failing.write(bytes(5))
    const handle = [...directory.entries_.values()][0] as unknown as { move: () => Promise<void> }
    handle.move = () => Promise.reject(new DOMException('busy', 'NoModificationAllowedError'))
    await expect(failing.commit()).rejects.toMatchObject({ name: 'NoModificationAllowedError' })
    expect(directory.names()).toEqual([])
  })

  test('reads a range without reading the whole file', async () => {
    const root = new FakeDirectoryHandle()
    const directory = await root.getDirectoryHandle('assets', { create: true })
    const data = bytes(1000)
    directory.put('big.bin', data)
    const store = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory })
    const source = (await store.open('big.bin'))!
    const file = await (await directory.getFileHandle('big.bin')).getFile()
    const slice = vi.spyOn(File.prototype, 'slice')
    expect(source.size).toBe(1000)
    expect(await source.read(100, 110)).toEqual(data.slice(100, 110))
    expect(slice).toHaveBeenCalledWith(100, 110)
    expect(file.size).toBe(1000)
  })

  test('passes quota errors through unchanged', async () => {
    const root = new FakeDirectoryHandle()
    const store = await OpfsFileStore.open({ root: root as unknown as OpfsDirectory })
    const writer = await store.create('a.bin')
    const directory = await root.getDirectoryHandle('assets')
    const handle = [...directory.entries_.values()][0] as unknown as { lastWritable: { quota: number } }
    handle.lastWritable.quota = 3
    await expect(writer.write(bytes(5))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await writer.abort()
    expect(directory.names()).toEqual([])
  })

  test('uses navigator.storage.getDirectory() by default', async () => {
    const root = new FakeDirectoryHandle()
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } })
    try {
      const store = await OpfsFileStore.open()
      const writer = await store.create('a.bin')
      await writer.commit()
      expect((await root.getDirectoryHandle('assets')).names()).toEqual(['a.bin'])
    } finally { vi.unstubAllGlobals() }
  })
})
