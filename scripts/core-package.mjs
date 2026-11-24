import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'packages/core')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const { name, version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const artifact = join(root, 'artifacts', `contextual-dictionary-core-${version}.tgz`)
const check = process.argv.includes('--check')
const temporary = mkdtempSync(join(tmpdir(), 'contextual-dictionary-core-'))

function node(args, cwd = root) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' })
}

try {
  const staging = join(temporary, 'source')
  mkdirSync(staging)
  node([tsc, '-p', join(source, 'tsconfig.json'), '--outDir', join(staging, 'dist')])
  copyFileSync(join(source, 'package.json'), join(staging, 'package.json'))
  copyFileSync(join(source, 'README.md'), join(staging, 'README.md'))
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  const [packed] = JSON.parse(execFileSync(process.execPath, [
    process.env.npm_execpath, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary, staging,
  ], { cwd: root, encoding: 'utf8' }))
  const generated = join(temporary, packed.filename)

  if (check) {
    assert.ok(readFileSync(artifact).equals(readFileSync(generated)), 'Core artifact is stale. Run npm run core:pack and update the lockfile.')
    const extensionLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    assert.equal(extensionLock.packages[`node_modules/${name}`]?.integrity, packed.integrity, 'Update the extension lockfile for the current core artifact.')
    const consumer = join(temporary, 'consumer')
    mkdirSync(consumer)
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    node([process.env.npm_execpath, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', artifact], consumer)
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'))
    assert.deepEqual(Object.keys(lock.packages), ['', `node_modules/${name}`])
    copyFileSync(join(root, 'test/fixtures/core.ts'), join(consumer, 'core.ts'))
    node([tsc, '--target', 'ES2022', '--lib', 'ES2023', '--module', 'NodeNext', '--strict', '--noEmit', 'core.ts'], consumer)
    node(['--experimental-strip-types', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      import { exerciseCore, expected } from './core.ts'
      assert.equal(createRequire(import.meta.url)('${name}/package.json').version, '${version}')
      assert.deepEqual(await exerciseCore(), expected)
    `], consumer)
  } else {
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    copyFileSync(generated, artifact)
  }
  console.log(`${check ? 'Verified' : 'Packed'} ${artifact} (${packed.size} bytes, ${packed.integrity})`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
