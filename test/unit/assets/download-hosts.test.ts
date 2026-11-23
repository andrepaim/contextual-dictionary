// The extension may reach exactly the hosts a release download touches:
// github.com for the release URL, then the host it redirects to (observed,
// see docs/assets.md). Both must be in `host_permissions` (so the offscreen
// page is not subject to CORS, which these hosts do not answer) and in the
// `connect-src` of the extension pages' content security policy.
import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import { ASSET_MANIFEST, BUNDLE_NAMES, fileUrl } from '../../../src/assets/manifest'

const manifest = JSON.parse(fs.readFileSync(new URL('../../../src/manifest.json', import.meta.url), 'utf8')) as {
  host_permissions: string[]
  content_security_policy: { extension_pages: string }
}

/** Where github.com redirected every assets-v1 download on 2026-11-23 (302, signed query string left out). */
const OBSERVED_REDIRECT = 'https://release-assets.githubusercontent.com/github-production-release-asset/1111111111/00000000-0000-4000-8000-000000000000?sp=r&sig=x'

const releaseUrls = BUNDLE_NAMES.flatMap(bundle => ASSET_MANIFEST.bundles[bundle].map(file => fileUrl(ASSET_MANIFEST, file)))

/** Chrome match pattern `<scheme>://<host><path>` with `*` wildcards; the query string is not part of the match. */
function matchesPattern(pattern: string, value: string): boolean {
  const parsed = /^(https|http|\*):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern)
  if (!parsed) throw new Error(`not a match pattern: ${pattern}`)
  const [, scheme, host, path] = parsed as unknown as [string, string, string, string]
  const url = new URL(value)
  if (scheme !== '*' ? url.protocol !== `${scheme}:` : !['http:', 'https:'].includes(url.protocol)) return false
  const hostOk = host === '*' || (host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host)
  const glob = new RegExp(`^${path.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return hostOk && glob.test(url.pathname)
}

const connectSources = () => {
  const directive = manifest.content_security_policy.extension_pages.split(';').map(part => part.trim().split(/\s+/)).find(([name]) => name === 'connect-src')
  if (!directive) throw new Error('no connect-src')
  return directive.slice(1)
}

/**
 * CSP host-source matching for an https URL: exact host (no wildcards
 * here), and a path that is a prefix when it ends with "/" and exact
 * otherwise. After a redirect the path is not checked (CSP Level 3).
 */
function allowedByCsp(sources: string[], value: string, redirected: boolean): boolean {
  const url = new URL(value)
  return sources.some(source => {
    if (source.startsWith("'")) return false
    const parsed = /^https:\/\/([^/:*]+)(\/.*)?$/.exec(source)
    if (!parsed) return false
    const [, host, path] = parsed as unknown as [string, string, string | undefined]
    if (url.protocol !== 'https:' || url.hostname !== host) return false
    if (!path || redirected) return true
    return path.endsWith('/') ? url.pathname.startsWith(path) : url.pathname === path
  })
}

describe('download hosts', () => {
  test('host_permissions cover every release URL and the observed redirect', () => {
    for (const url of [...releaseUrls, OBSERVED_REDIRECT]) expect(manifest.host_permissions.some(pattern => matchesPattern(pattern, url)), url).toBe(true)
  })

  test('connect-src allows every release URL and the observed redirect', () => {
    const sources = connectSources()
    for (const url of releaseUrls) expect(allowedByCsp(sources, url, false), url).toBe(true)
    expect(allowedByCsp(sources, OBSERVED_REDIRECT, true)).toBe(true)
    expect(sources).toContain("'self'")
  })

  test('grant nothing beyond those hosts', () => {
    expect(manifest.host_permissions).toEqual([
      'https://github.com/andrepaim/contextual-dictionary/releases/download/*',
      'https://release-assets.githubusercontent.com/*',
    ])
    for (const pattern of manifest.host_permissions) {
      expect([...releaseUrls, OBSERVED_REDIRECT].some(url => matchesPattern(pattern, url)), pattern).toBe(true)
      expect(matchesPattern(pattern, 'https://example.org/releases/download/x')).toBe(false)
    }
    expect(matchesPattern(manifest.host_permissions[0]!, 'https://github.com/someone/else/releases/download/assets-v1/x')).toBe(false)
    const sources = connectSources()
    expect(sources).toEqual(["'self'", 'https://github.com/andrepaim/contextual-dictionary/releases/download/', 'https://release-assets.githubusercontent.com'])
    expect(allowedByCsp(sources, 'https://github.com/someone/else', false)).toBe(false)
    expect(allowedByCsp(sources, 'https://example.org/', false)).toBe(false)
  })

  test('the matchers used here behave as Chrome and CSP do on simple cases', () => {
    expect(matchesPattern('https://*.example.org/*', 'https://a.example.org/x')).toBe(true)
    expect(matchesPattern('https://*.example.org/*', 'https://example.org/x')).toBe(true)
    expect(matchesPattern('https://*.example.org/*', 'https://badexample.org/x')).toBe(false)
    expect(matchesPattern('*://*/*', 'http://x.test/')).toBe(true)
    expect(matchesPattern('https://x.test/a/*', 'http://x.test/a/b')).toBe(false)
    expect(() => matchesPattern('nonsense', 'https://x.test/')).toThrow()
    expect(allowedByCsp(['https://x.test/a'], 'https://x.test/a', false)).toBe(true)
    expect(allowedByCsp(['https://x.test/a'], 'https://x.test/ab', false)).toBe(false)
    expect(allowedByCsp(['https://x.test/a/'], 'https://x.test/b', true)).toBe(true)
    expect(allowedByCsp(['*'], 'https://x.test/', false)).toBe(false)
  })
})
