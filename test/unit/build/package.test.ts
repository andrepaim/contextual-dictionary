import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { MAX_ZIP_BYTES, packageBuild, packageExtension, writeZip } from '../../../scripts/package.mjs'

const directories: string[] = []
const temporary = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-package-')); directories.push(directory); return directory }
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

interface Entry { name: string; data: Buffer; time: number; date: number; external: number; method: number }

/** Reads a ZIP through its central directory, checking each entry's CRC-32. */
function readZip(zip: Buffer): Entry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const entries: Entry[] = []
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const method = zip.readUInt16LE(at + 10), time = zip.readUInt16LE(at + 12), date = zip.readUInt16LE(at + 14)
    const crc = zip.readUInt32LE(at + 16), compressed = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32), external = zip.readUInt32LE(at + 38), local = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(crc32(data) >>> 0, name).toBe(crc)
    entries.push({ name, data, time, date, external, method })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('writeZip', () => {
  test('sorts entries and fixes their times and permissions, whatever the input order', () => {
    const a = writeZip([{ name: 'b.txt', data: Buffer.from('bee') }, { name: 'a/x.js', data: Buffer.from('x'.repeat(1000)) }])
    const b = writeZip([{ name: 'a/x.js', data: Buffer.from('x'.repeat(1000)) }, { name: 'b.txt', data: Buffer.from('bee') }])
    expect(Buffer.compare(a, b)).toBe(0)
    const entries = readZip(a)
    expect(entries.map(entry => entry.name)).toEqual(['a/x.js', 'b.txt'])
    expect(entries[0]!.data.toString()).toBe('x'.repeat(1000))
    expect(entries[0]!.method).toBe(8)
    for (const entry of entries) {
      expect(entry.date).toBe((0 << 9) | (1 << 5) | 1) // 1980-01-01
      expect(entry.time).toBe(0)
      expect(entry.external >>> 16).toBe(0o100644)
    }
  })

  test('stores data that does not compress', () => {
    const noise = createHash('sha512').update('x').digest()
    const [entry] = readZip(writeZip([{ name: 'n.bin', data: noise }]))
    expect(entry!.method).toBe(0)
    expect(Buffer.compare(entry!.data, noise)).toBe(0)
  })

  test('refuses names that are not plain relative paths', () => {
    for (const name of ['/abs', '../up', 'a\\b', '']) expect(() => writeZip([{ name, data: Buffer.from('') }]), name).toThrow()
  })
})

describe('packageBuild', () => {
  test('refuses a build that fails the build check', () => {
    const build = temporary()
    fs.writeFileSync(path.join(build, 'manifest.json'), JSON.stringify({ manifest_version: 2 }))
    expect(() => packageBuild(build, temporary(), '0.1.0')).toThrow(/manifest_version/)
  })
})

describe('packageExtension', () => {
  test('two builds of one commit give the same ZIP, under the size budget, with the licences, icons and checksums', async () => {
    const first = await packageExtension({ buildDir: temporary(), outDir: temporary() })
    const second = await packageExtension({ buildDir: temporary(), outDir: temporary() })
    expect(first.sha256).toBe(second.sha256)
    const version = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version
    expect(path.basename(first.zipPath)).toBe(`contextual-dictionary-${version}.zip`)
    const zip = fs.readFileSync(first.zipPath)
    expect(createHash('sha256').update(zip).digest('hex')).toBe(first.sha256)
    expect(zip.length).toBeLessThan(MAX_ZIP_BYTES)
    expect(MAX_ZIP_BYTES).toBe(30 * 1024 * 1024)
    expect(fs.readFileSync(path.join(path.dirname(first.zipPath), 'SHA256SUMS.txt'), 'utf8')).toBe(`${first.sha256}  contextual-dictionary-${version}.zip\n`)
    const names = readZip(zip).map(entry => entry.name)
    for (const name of ['manifest.json', 'service-worker.js', 'content.js', 'offscreen.js', 'model-worker.js', 'popup.js', 'popup.html', 'offscreen.html',
      'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs', 'icons/icon-16.png', 'icons/icon-128.png',
      'LICENSE', 'NOTICE.md', 'licenses/NOTICES-dictionary.txt', 'licenses/NOTICES-model.txt',
      'licenses/onnxruntime-LICENSE.txt', 'licenses/onnxruntime-ThirdPartyNotices.txt', 'licenses/huggingface-tokenizers-LICENSE.txt', 'licenses/noble-hashes-LICENSE.txt']) {
      expect(names, name).toContain(name)
    }
    expect(names).not.toContain('e2e-config.json')
    const manifest = JSON.parse(readZip(zip).find(entry => entry.name === 'manifest.json')!.data.toString())
    expect(manifest.version).toBe(version)
    expect(manifest.icons['128']).toBe('icons/icon-128.png')
  }, 120_000)
})
