// Launches Chromium with the end-to-end build of the extension (dist-e2e/,
// built by `npm run test:e2e`), a loopback asset server and the fixture pages.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import type { Answers, BundleName, Request, Status } from '../../../src/shared/contracts'
import { assetFixture, type AssetFixture } from './assets'
import { startAssetServer, type AssetServer } from './asset-server'
import { serveFixtures } from '../helpers'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const E2E_DIR = path.join(root, 'dist-e2e')

export interface Session {
  context: BrowserContext
  extensionId: string
  server: AssetServer
  fixture: AssetFixture
  /** Fixture pages, at http://127.0.0.1:<port>. */
  pages: string
  /** The same fixture server under the name localhost, which the e2e host permission does not cover. */
  localhost: string
  extensionDir: string
  userDataDir: string
  /** The service worker as launched. */
  worker: Worker
  /** An extension page (popup.html in a tab) for sending requests and reading private storage; blank with `control: false`. */
  control: Page
  close(options?: { keepProfile?: boolean }): Promise<void>
}

const temporary = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `cd-e2e-${prefix}-`))

/**
 * Chromium with a copy of the end-to-end build whose e2e-config.json points at
 * a new asset server. Pass `reuse` to start again on the same profile and
 * extension directory (the extension keeps its id and private files).
 */
export async function launch(options: { reuse?: Session; control?: boolean; args?: string[]; defaults?: boolean } = {}): Promise<Session> {
  if (!fs.existsSync(path.join(E2E_DIR, 'manifest.json'))) throw new Error('Build the end-to-end variant first: node scripts/build.mjs --e2e')
  const fixture = await assetFixture()
  const server = await startAssetServer(fixture)
  const fixtures = await serveFixtures()
  const extensionDir = options.reuse?.extensionDir ?? temporary('extension')
  const userDataDir = options.reuse?.userDataDir ?? temporary('profile')
  if (!options.reuse) fs.cpSync(E2E_DIR, extensionDir, { recursive: true })
  fs.writeFileSync(path.join(extensionDir, 'e2e-config.json'), JSON.stringify({ manifest: fixture.manifest(server.url) }))
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, ...(options.args ?? [])],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  // The tests start with "Order by context" off, as a reader who switched it off, unless they ask for
  // the shipped defaults (ordering on since stage 3). A restarted session keeps what it had.
  if (!options.reuse && !options.defaults) await worker.evaluate(() => chrome.storage.local.set({ settings: { orderByContext: false } }))
  // Opening it creates the offscreen document (the popup asks for the live status).
  const control = await context.newPage()
  if (options.control ?? true) await control.goto(`chrome-extension://${extensionId}/popup.html`)
  const port = new URL(fixtures.url).port
  return {
    context, extensionId, server, fixture, extensionDir, userDataDir, control, worker,
    pages: fixtures.url,
    localhost: `http://localhost:${port}`,
    async close({ keepProfile = false } = {}) {
      await context.close()
      await server.close()
      await fixtures.close()
      if (!keepProfile) for (const directory of [extensionDir, userDataDir]) fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** Sends a request as the popup does, and returns the answer or the error reply. */
export async function send<T extends Request>(page: Page, request: T): Promise<{ ok: true; value: Answers[T['type']] } | { ok: false; code: string; message: string }> {
  return page.evaluate(message => chrome.runtime.sendMessage(message), request)
}

export async function status(page: Page): Promise<Status> {
  const reply = await send(page, { type: 'status' })
  if (!reply.ok) throw new Error(`status failed: ${reply.code}`)
  return reply.value
}

/** Downloads bundles through the real path (service worker, offscreen document, asset server) and waits until installed. */
export async function install(session: Session, ...bundles: BundleName[]): Promise<void> {
  for (const bundle of bundles) {
    const reply = await send(session.control, { type: 'download', bundle, acceptBytes: session.fixture.bytes(bundle) })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
  }
  await expect.poll(async () => { const now = await status(session.control); return bundles.map(bundle => now.bundles[bundle].phase) }, { timeout: 15_000 })
    .toEqual(bundles.map(() => 'ready'))
  // The popup shows what is installed now.
  if (session.control.url().startsWith('chrome-extension://')) await session.control.reload()
}

/** The extension's service worker as it runs now (it may have been restarted). */
export async function serviceWorker(session: Session): Promise<Worker> {
  for (const worker of [...session.context.serviceWorkers()].reverse()) {
    if (!worker.url().startsWith(`chrome-extension://${session.extensionId}/`)) continue
    try { await worker.evaluate(() => 1); return worker } catch { /* stopped */ }
  }
  await status(session.control)
  const worker = session.context.serviceWorkers().at(-1)
  if (!worker) throw new Error('no service worker')
  return worker
}

/** Request counts of the service worker since it last started. */
export async function requestCounts(session: Session): Promise<Record<string, number>> {
  return (await serviceWorker(session)).evaluate(() => ({ ...(globalThis as unknown as { contextualDictionary: { requests: Record<string, number> } }).contextualDictionary.requests }))
}

/** Stops the extension's service worker, as Chrome does after it has been idle. */
export async function stopServiceWorker(session: Session): Promise<void> {
  const page = await session.context.newPage()
  await page.goto('chrome://serviceworker-internals/')
  const registration = page.locator('.serviceworker-registration').filter({ hasText: session.extensionId })
  await expect(registration.getByText('RUNNING', { exact: true }).first()).toBeVisible()
  await registration.getByRole('button', { name: 'Stop' }).click()
  await expect(registration.getByText('STOPPED', { exact: true }).first()).toBeVisible()
  await page.close()
}

export async function offscreenOpen(session: Session): Promise<boolean> {
  const worker = await serviceWorker(session)
  return worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0)
}

export async function closeOffscreen(session: Session): Promise<void> {
  const worker = await serviceWorker(session)
  await worker.evaluate(() => chrome.offscreen.closeDocument())
  await expect.poll(() => offscreenOpen(session)).toBe(false)
}

/** The names in the extension's private file storage, temporary files included. */
export async function storedFiles(session: Session): Promise<Array<{ name: string; size: number }>> {
  return session.control.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('assets', { create: true })
    const out: Array<{ name: string; size: number }> = []
    for await (const [name, handle] of (directory as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'file') out.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })
}
