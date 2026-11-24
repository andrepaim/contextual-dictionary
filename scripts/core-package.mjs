import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'packages/core')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const { name, version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const artifactPath = `artifacts/contextual-dictionary-core-${version}.tgz`
const artifact = join(root, artifactPath)
const check = process.argv.includes('--check')
const temporary = mkdtempSync(join(tmpdir(), 'contextual-dictionary-core-'))

function node(args, cwd = root) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' })
}

try {
  const staging = join(temporary, 'source')
  mkdirSync(staging)
  node([tsc, '-p', join(source, 'tsconfig.json'), '--outDir', join(staging, 'dist')])
  copyFileSync(join(source, 'src/card.css'), join(staging, 'dist/card.css'))
  copyFileSync(join(source, 'package.json'), join(staging, 'package.json'))
  copyFileSync(join(source, 'README.md'), join(staging, 'README.md'))
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  const [packed] = JSON.parse(execFileSync(process.execPath, [
    process.env.npm_execpath, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', temporary, staging,
  ], { cwd: root, encoding: 'utf8' }))
  const generated = join(temporary, packed.filename)

  if (check) {
    assert.ok(readFileSync(artifact).equals(readFileSync(generated)), 'Core artifact differs from source. Bump the core version, pack it and update the lockfile.')
    const extensionLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    const lockedCore = extensionLock.packages[`node_modules/${name}`]
    assert.equal(lockedCore?.resolved, `file:${artifactPath}`, 'Update the extension pin and lockfile for the current core artifact.')
    assert.equal(lockedCore.integrity, packed.integrity, 'Update the extension lockfile for the current core artifact.')
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
      import * as engine from '${name}'
      import { cardPreview } from '${name}/card'
      import { cardFixture } from '${name}/card-fixture'
      import { exerciseCore, expected } from './core.ts'
      assert.equal(createRequire(import.meta.url)('${name}/package.json').version, '${version}')
      assert.deepEqual(await exerciseCore(), expected)
      assert.equal('cardPreview' in engine, false)
      assert.equal('cardFixture' in engine, false)
      const preview = cardPreview(cardFixture.entries, false)
      assert.equal(preview.canExpand, true)
      assert.equal(preview.entries.length, 3)
    `], consumer)
    const { outputFiles } = await build({
      stdin: {
        contents: `export { default } from '${name}/card.css'`,
        resolveDir: consumer,
      },
      bundle: true,
      write: false,
      format: 'esm',
      loader: { '.css': 'text' },
    })
    const { default: css } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
    assert.equal(css, readFileSync(join(source, 'src/card.css'), 'utf8'))
  } else {
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    if (existsSync(artifact)) {
      assert.ok(readFileSync(artifact).equals(readFileSync(generated)), 'Existing core artifacts are immutable. Bump the core version before packing changes.')
    } else {
      copyFileSync(generated, artifact, constants.COPYFILE_EXCL)
    }
  }
  console.log(`${check ? 'Verified' : 'Packed'} ${artifact} (${packed.size} bytes, ${packed.integrity})`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
