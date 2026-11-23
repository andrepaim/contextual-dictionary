// Checks a built extension before it is packaged or published:
//
//   node scripts/check-build.mjs [directory]     (default dist/)
//
// - the manifest is valid Manifest V3: required fields, a Chrome version
//   string, a module service worker, every referenced file present, only the
//   expected permissions, nothing exposed to web pages;
// - no remote code: the content security policy allows scripts and workers
//   from the extension only, and no script or page loads code from a URL;
// - every web address in the code is on a known host (attribution links and
//   the release download hosts), so nothing new phones home unnoticed;
// - nothing of the end-to-end variant (scripts/build.mjs --e2e) is present.
// Prints the problems and exits with 1 when there are any.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_MARKER = '__CD_E2E_VARIANT__'
const PERMISSIONS = new Set(['storage', 'offscreen', 'unlimitedStorage'])
/** Hosts of the links the card and popup show, and of comments the bundled libraries keep. */
const KNOWN_HOSTS = new Set(['en.wiktionary.org', 'creativecommons.org', 'huggingface.co', 'github.com', 'web.dev'])
const LOOPBACK = /\b(?:127\.0\.0\.1|localhost|\[::1\])\b/
const REMOTE_CODE = [
  /\bimport\s*\(\s*["'`]https?:/,
  /\bfrom\s*["']https?:/,
  /\bimportScripts\s*\(\s*["'`]?https?:/,
  /\bnew\s+(?:Shared)?Worker\s*\(\s*["'`]https?:/,
]
const REMOTE_PAGE = [/<script[^>]*\ssrc\s*=\s*["']?https?:/i, /<link[^>]*\shref\s*=\s*["']?https?:/i, /<iframe[^>]*\ssrc\s*=\s*["']?https?:/i]

function files(directory) {
  return fs.readdirSync(directory, { recursive: true }).map(String).filter(name => fs.statSync(path.join(directory, name)).isFile()).sort()
}

function policyProblems(policy) {
  const problems = []
  if (typeof policy !== 'string') return ['the content security policy for extension pages is missing']
  const directives = new Map(policy.split(';').map(part => part.trim().split(/\s+/)).filter(tokens => tokens[0]).map(([name, ...values]) => [name, values]))
  const only = (name, allowed) => {
    const values = directives.get(name) ?? directives.get('default-src') ?? []
    const extra = values.filter(value => !allowed.includes(value))
    if (!values.length || extra.length) problems.push(`the content security policy allows ${name} ${extra.join(' ') || '(nothing set)'}`)
  }
  only('script-src', ["'self'", "'wasm-unsafe-eval'"])
  only('worker-src', ["'self'"])
  only('object-src', ["'none'", "'self'"])
  if (/'unsafe-eval'|(^|\s)\*(\s|;|$)/.test(policy)) problems.push('the content security policy allows evaluated code or any source')
  return problems
}

/** The problems of the build in `directory`; empty when it may be published. */
export function checkBuild(directory) {
  const problems = []
  const manifestPath = path.join(directory, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return [`${directory} has no manifest.json`]
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { return ['manifest.json is not JSON'] }
  const present = new Set(files(directory).map(name => name.split(path.sep).join('/')))
  const need = (file, where) => { if (typeof file !== 'string' || !present.has(file)) problems.push(`${where} names ${file}, which is not in the build`) }

  // Manifest V3
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3')
  for (const key of ['name', 'description']) if (typeof manifest[key] !== 'string' || !manifest[key]) problems.push(`manifest ${key} is missing`)
  if (typeof manifest.version !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version) || manifest.version.split('.').some(part => Number(part) > 65535)) problems.push(`manifest version ${manifest.version} is not a Chrome version (1 to 4 numbers)`)
  if (typeof manifest.background?.service_worker !== 'string') problems.push('background.service_worker is missing')
  else need(manifest.background.service_worker, 'background.service_worker')
  if (manifest.background?.type !== 'module') problems.push('the service worker must be a module')
  if ('web_accessible_resources' in manifest) problems.push('web_accessible_resources would expose extension files to web pages')
  for (const permission of manifest.permissions ?? []) if (!PERMISSIONS.has(permission)) problems.push(`unexpected permission ${permission}`)
  for (const script of manifest.content_scripts ?? []) for (const file of [...(script.js ?? []), ...(script.css ?? [])]) need(file, 'content_scripts')
  if (manifest.action?.default_popup) need(manifest.action.default_popup, 'action.default_popup')
  for (const icons of [manifest.icons, manifest.action?.default_icon]) if (icons && typeof icons === 'object') for (const file of Object.values(icons)) need(file, 'icons')

  // No remote code
  problems.push(...policyProblems(manifest.content_security_policy?.extension_pages))
  const hosts = new Set(KNOWN_HOSTS)
  for (const pattern of manifest.host_permissions ?? []) { try { hosts.add(new URL(pattern.replace(/\*$/, '')).hostname) } catch { /* checked below */ } }
  for (const name of present) {
    const text = /\.(m?js|html|json)$/.test(name) ? fs.readFileSync(path.join(directory, name), 'utf8') : ''
    if (/\.m?js$/.test(name) && REMOTE_CODE.some(pattern => pattern.test(text))) problems.push(`${name} loads remote code`)
    if (name.endsWith('.html') && REMOTE_PAGE.some(pattern => pattern.test(text))) problems.push(`${name} loads remote code`)
    if (/\.(m?js|html)$/.test(name)) {
      for (const [address] of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) {
        const host = new URL(address).hostname
        if (!hosts.has(host) && !LOOPBACK.test(host)) problems.push(`${name} names the unknown host ${host}`)
      }
    }
    if (text.includes(E2E_MARKER)) problems.push(`${name} contains the end-to-end test variant`)
  }

  // No end-to-end variant
  if (present.has('e2e-config.json')) problems.push('e2e-config.json belongs to the end-to-end variant')
  if ((manifest.host_permissions ?? []).some(pattern => LOOPBACK.test(pattern))) problems.push('host_permissions include a loopback address (end-to-end variant)')
  if (LOOPBACK.test(manifest.content_security_policy?.extension_pages ?? '')) problems.push('the content security policy allows a loopback address (end-to-end variant)')
  return [...new Set(problems)]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url)))
  const problems = checkBuild(directory)
  if (problems.length) {
    console.error(`The build in ${directory} cannot be published:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`Checked ${path.relative(process.cwd(), directory) || '.'}: Manifest V3, no remote code, no end-to-end variant.`)
}
