import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Worker } from '@playwright/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const EXTENSION_DIR = path.join(root, 'dist')
export const FIXTURES_DIR = path.join(root, 'test/fixtures')

/** Chromium with the built extension loaded, in a throwaway profile. */
export async function launchExtension(extension = EXTENSION_DIR): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  if (!fs.existsSync(path.join(extension, 'manifest.json'))) throw new Error('Build the extension first: npm run build')
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  return { context, worker, extensionId: new URL(worker.url()).host }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }

/** Serves test/fixtures on a loopback port, so content scripts run on an ordinary http page. */
export async function serveFixtures(directory = FIXTURES_DIR): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const file = path.join(directory, path.normalize(name))
    if (!file.startsWith(directory) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(() => resolve())) }
}
