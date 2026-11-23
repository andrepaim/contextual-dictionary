import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { checkBuild } from '../../../scripts/check-build.mjs'
// @ts-expect-error plain JavaScript build script without types
import { buildExtension } from '../../../scripts/build.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://github.com/andrepaim/contextual-dictionary/releases/download/; object-src 'none'"

/** A minimal build that passes every check; `change` alters it first. */
function fakeBuild(change: (files: Record<string, string>, manifest: Record<string, any>) => void = () => {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-check-build-'))
  directories.push(directory)
  const manifest: Record<string, any> = {
    manifest_version: 3, name: 'Contextual Dictionary', version: '0.1.0', description: 'x',
    permissions: ['storage', 'offscreen', 'unlimitedStorage'],
    host_permissions: ['https://github.com/andrepaim/contextual-dictionary/releases/download/*'],
    background: { service_worker: 'service-worker.js', type: 'module' },
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
    content_security_policy: { extension_pages: CSP },
  }
  const files: Record<string, string> = {
    'service-worker.js': 'chrome.runtime.onMessage.addListener(() => {})',
    'content.js': 'const link = "https://en.wiktionary.org/wiki/" + word',
    'offscreen.js': 'fetch(url)', 'offscreen.html': '<script type="module" src="offscreen.js"></script>',
    'popup.js': 'x', 'popup.html': '<script type="module" src="popup.js"></script>', 'model-worker.js': 'x',
  }
  change(files, manifest)
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content)
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
  return directory
}

describe('checkBuild', () => {
  test('a clean build has no problems', () => {
    expect(checkBuild(fakeBuild())).toEqual([])
  })

  test('refuses a manifest that is not valid Manifest V3', () => {
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.manifest_version = 2 }))).toContainEqual(expect.stringMatching(/manifest_version/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.version = '0.1.0-beta' }))).toContainEqual(expect.stringMatching(/version/))
    expect(checkBuild(fakeBuild((_, manifest) => { delete manifest.name }))).toContainEqual(expect.stringMatching(/name/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.background = { scripts: ['bg.js'] } }))).toContainEqual(expect.stringMatching(/service_worker/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.content_scripts[0].js = ['missing.js'] }))).toContainEqual(expect.stringMatching(/missing\.js/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.web_accessible_resources = ['a.js'] }))).toContainEqual(expect.stringMatching(/web_accessible_resources/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.permissions.push('tabs') }))).toContainEqual(expect.stringMatching(/permission.*tabs/))
  })

  test('refuses a content security policy that allows remote or evaluated code', () => {
    for (const policy of [CSP.replace("script-src 'self'", "script-src 'self' https://cdn.example"), CSP.replace("'wasm-unsafe-eval'", "'unsafe-eval'"), CSP.replace("worker-src 'self'", 'worker-src *')]) {
      expect(checkBuild(fakeBuild((_, manifest) => { manifest.content_security_policy.extension_pages = policy })), policy).toContainEqual(expect.stringMatching(/content security policy/))
    }
  })

  test('refuses remote code in scripts and pages', () => {
    expect(checkBuild(fakeBuild(files => { files['offscreen.js'] = 'await import("https://cdn.example/x.js")' }))).toContainEqual(expect.stringMatching(/remote code/))
    expect(checkBuild(fakeBuild(files => { files['model-worker.js'] = "importScripts('https://cdn.example/x.js')" }))).toContainEqual(expect.stringMatching(/remote code/))
    expect(checkBuild(fakeBuild(files => { files['popup.html'] = '<script src="https://cdn.example/x.js"></script>' }))).toContainEqual(expect.stringMatching(/remote code/))
  })

  test('refuses addresses on hosts it does not know', () => {
    expect(checkBuild(fakeBuild(files => { files['offscreen.js'] = 'fetch("https://tracker.example/collect")' }))).toContainEqual(expect.stringMatching(/tracker\.example/))
  })

  test('refuses anything of the end-to-end variant', () => {
    expect(checkBuild(fakeBuild(files => { files['offscreen.js'] = 'const marker = "__CD_E2E_VARIANT__"' }))).toContainEqual(expect.stringMatching(/end-to-end/))
    expect(checkBuild(fakeBuild(files => { files['e2e-config.json'] = '{}' }))).toContainEqual(expect.stringMatching(/e2e-config\.json/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.host_permissions.push('http://127.0.0.1/*') }))).toContainEqual(expect.stringMatching(/loopback/))
    expect(checkBuild(fakeBuild((_, manifest) => { manifest.content_security_policy.extension_pages = CSP.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:*") }))).toContainEqual(expect.stringMatching(/loopback/))
  })

  test('the real end-to-end build fails the production check, and the production build passes it', async () => {
    const e2e = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-check-e2e-'))
    const production = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-check-prod-'))
    directories.push(e2e, production)
    await buildExtension(e2e, { e2e: true })
    await buildExtension(production)
    const problems: string[] = checkBuild(e2e)
    expect(problems).toContainEqual(expect.stringMatching(/end-to-end/))
    expect(problems).toContainEqual(expect.stringMatching(/loopback/))
    expect(checkBuild(production)).toEqual([])
  }, 60_000)
})
