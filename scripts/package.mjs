// Builds the production extension and packs it as the release ZIP:
//
//   node scripts/package.mjs     dist/, then package/contextual-dictionary-<version>.zip and package/SHA256SUMS.txt
//
// The ZIP is reproducible: entries sorted by name, every timestamp
// 1980-01-01 00:00, permissions 0644, no extra fields, deflate level 9 from
// Node's zlib. Two builds of one commit give the same SHA-256. The build must
// pass scripts/check-build.mjs and the ZIP must stay under 30 MB.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { buildExtension } from './build.mjs'
import { checkBuild } from './check-build.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const MAX_ZIP_BYTES = 30 * 1024 * 1024
const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01
const DOS_TIME = 0
const UTF8 = 0x0800
const MODE = 0o100644

/** A ZIP of `entries` ({ name, data }) that depends only on their names and bytes. */
export function writeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const locals = [], centrals = []
  let offset = 0
  for (const { name, data } of sorted) {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '')) throw new Error(`Not a plain relative path: ${JSON.stringify(name)}`)
    const nameBytes = Buffer.from(name, 'utf8')
    const bytes = Buffer.from(data)
    const deflated = deflateRawSync(bytes, { level: 9 })
    const stored = deflated.length >= bytes.length
    const body = stored ? bytes : deflated
    const crc = crc32(bytes) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so the permissions below are read
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((MODE << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Checks the build in `buildDir` and writes its ZIP and SHA256SUMS.txt to `outDir`. */
export function packageBuild(buildDir, outDir, version) {
  const problems = checkBuild(buildDir)
  if (problems.length) throw new Error(`The build cannot be packaged:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  const names = fs.readdirSync(buildDir, { recursive: true }).map(String).filter(name => fs.statSync(path.join(buildDir, name)).isFile())
  const zip = writeZip(names.map(name => ({ name: name.split(path.sep).join('/'), data: fs.readFileSync(path.join(buildDir, name)) })))
  if (zip.length >= MAX_ZIP_BYTES) throw new Error(`The ZIP is ${zip.length} bytes, over the budget of ${MAX_ZIP_BYTES}`)
  const file = `contextual-dictionary-${version}.zip`
  const sha256 = createHash('sha256').update(zip).digest('hex')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, file), zip)
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sha256}  ${file}\n`)
  return { zipPath: path.join(outDir, file), sha256, size: zip.length }
}

/** Builds the production extension into `buildDir` and packages it into `outDir`. */
export async function packageExtension({ buildDir = path.join(root, 'dist'), outDir = path.join(root, 'package') } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  await buildExtension(buildDir)
  return packageBuild(buildDir, outDir, version)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { zipPath, sha256, size } = await packageExtension()
    console.log(`Packed ${path.relative(root, zipPath)} (${(size / 1e6).toFixed(1)} MB)\nSHA-256 ${sha256}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
