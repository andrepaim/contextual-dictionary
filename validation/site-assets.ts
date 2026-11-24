// Makes what the project site shows of the running extension (site/, see
// scripts/build-site.mjs): the extension's answers for the examples, written
// into site/_examples.json, and the pictures in site/images/.
//
//   npm run build
//   npx tsx validation/site-assets.ts [--answers-only]
//
// Everything is real: the built extension in Chromium with the real
// dictionary and model (release assets-v1, downloaded once into the profile
// that validation/store-assets.ts also uses), looking words up on the site's
// own practice page, served from this computer. The pictures are captures of
// the browser window, cut off below the card and otherwise untouched; only
// the social card is composed, around one of them. Opt-in, never part of CI.
//
// Captures take the fonts of the machine they run on. To render the card as
// Chrome on Windows does, point FONTCONFIG_FILE at a configuration that maps
// system-ui to Segoe UI.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
// @ts-expect-error plain JavaScript build script without types
import { copyStatic, readExamples, renderPage } from '../scripts/build-site.mjs'
import type { Status } from '../src/shared/contracts'
import { doubleClickWord } from '../test/e2e/support/card'

interface Answer { first: string; was?: number }
interface Example { id: string; show: string; word: string; result?: { dictionary: Answer; context: Answer; entries: string[]; status: string | null } }
interface Examples { extension: string; examples: Example[] }

const extension = path.resolve('dist')
const profile = path.join(os.homedir(), '.cache/contextual-dictionary/store-profile')
const images = path.resolve('site/images')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const CARD = 'contextual-dictionary-card [data-part="card"]'
/** The opening pictures start just below the rule above the passage (the page keeps 24 pixels above a scrolled-to element). */
const HERO_ABOVE = -26
const HAMLET = 'https://shakespeare.mit.edu/hamlet/hamlet.3.1.html'

// The site, built without the home page (whose pictures this script makes), on a local address.
const served = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-site-assets-'))
const data = readExamples() as Examples
copyStatic(served)
fs.writeFileSync(path.join(served, 'try.html'), renderPage('try.html', data))
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' }
const server = http.createServer((request, response) => {
  const file = path.join(served, path.normalize(new URL(request.url ?? '/', 'http://x').pathname))
  if (!file.startsWith(served) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end()
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

async function launch(): Promise<{ context: BrowserContext; popup: Page }> {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 900, height: 760 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
  return { context, popup }
}
const statusOf = (popup: Page) => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })).then(reply => (reply as { value: Status }).value)
async function waitFor(popup: Page, test: (status: Status) => boolean, what: string) {
  for (const started = Date.now(); ;) {
    if (test(await statusOf(popup))) return
    if (Date.now() - started > 900_000) throw new Error(`timed out waiting for ${what}`)
    await sleep(300)
  }
}
const set = (popup: Page, patch: { showOrderDetails?: boolean; orderByContext?: boolean }) => popup.evaluate(patch => chrome.runtime.sendMessage({ type: 'set-settings', patch }), patch).then(() => sleep(300))
async function setOrder(popup: Page, on: boolean) {
  await set(popup, { orderByContext: on })
  if (on) await waitFor(popup, status => status.ranker.state === 'ready' || status.ranker.state === 'idle', 'the model')
}

/** Double-clicks the example's word in its passage, with the passage `above` pixels below the top of the window, and waits for the final card. */
async function lookUp(page: Page, example: Example, above = 90) {
  await page.keyboard.press('Escape')
  await page.mouse.click(2, 2)
  const passage = page.locator(`#${example.id} p`)
  await passage.evaluate((node, above) => { node.closest('article')!.scrollIntoView({ block: 'start', behavior: 'instant' }); window.scrollBy({ top: -above, behavior: 'instant' }) }, above)
  await sleep(200)
  await doubleClickWord(passage, example.word)
  await page.locator(CARD).waitFor()
  await page.mouse.move(2, 300)
  await sleep(700)
}
/** The lookup twice with ordering on: the second takes the model's answer when the first missed the time budget. */
async function ordered(page: Page, example: Example, above?: number) {
  await lookUp(page, example, above)
  await sleep(1500)
  await lookUp(page, example, above)
}
/** What the card shows: its entries, the meanings of the first one with their "was" tags, and the status line. */
const shown = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('contextual-dictionary-card')!.shadowRoot!
  const entries = [...root.querySelectorAll('section.dc-entry')]
  return {
    entries: entries.map(entry => `${entry.querySelector('[data-part="lemma"]')?.textContent} (${entry.querySelector('[data-part="pos"]')?.textContent})`),
    senses: [...(entries[0]?.querySelectorAll('li') ?? [])].map(item => ({ text: item.querySelector('[data-part="definition"]')?.textContent ?? '', was: item.querySelector('[data-part="was"]')?.textContent ?? null })),
    status: root.querySelector('[data-part="order-status"]')?.textContent ?? null,
  }
})

/** The extension's answers for every example, in both orders, into site/_examples.json. */
async function answers(popup: Page, page: Page) {
  await set(popup, { showOrderDetails: true })
  await setOrder(popup, false)
  const inDictionaryOrder = new Map<string, Awaited<ReturnType<typeof shown>>>()
  for (const example of data.examples) {
    await lookUp(page, example)
    inDictionaryOrder.set(example.id, await shown(page))
  }
  await setOrder(popup, true)
  for (const example of data.examples) {
    await ordered(page, example)
    const dictionary = inDictionaryOrder.get(example.id)!, context = await shown(page)
    const was = /\d+/.exec(context.senses[0]!.was ?? '')?.[0]
    example.result = {
      dictionary: { first: dictionary.senses[0]!.text },
      context: { first: context.senses[0]!.text, ...(was ? { was: Number(was) } : {}) },
      entries: context.entries,
      status: context.status,
    }
    console.log(`${example.id} (${example.word}): ${example.result.dictionary.first.slice(0, 60)} → ${example.result.context.first.slice(0, 60)}${was ? ` [was ${was}]` : ''} · ${context.status}`)
  }
  data.extension = (JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) as { version: string }).version
  fs.writeFileSync('site/_examples.json', `${JSON.stringify(data, null, 2)}\n`)
  await set(popup, { showOrderDetails: false })
}

/** The opening pictures: the same lookup in both orders, in both colour schemes, for a wide and a narrow column. */
async function lookups(popup: Page, page: Page) {
  const hero = data.examples.find(example => example.show === 'hero')!
  const bottom = async () => Math.ceil((await page.locator(CARD).boundingBox())!.y + (await page.locator(CARD).boundingBox())!.height)
  for (const [suffix, width] of [['', 600], ['-narrow', 400]] as const) {
    await page.setViewportSize({ width, height: 760 })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      // Both pictures are cut at the same height, below the taller of the two cards.
      await setOrder(popup, false)
      await lookUp(page, hero, HERO_ABOVE)
      let height = await bottom()
      await setOrder(popup, true)
      await ordered(page, hero, HERO_ABOVE)
      height = Math.max(height, await bottom()) + 22
      const name = (order: string) => path.join(images, `lookup-${order}${suffix}${scheme === 'dark' ? '-dark' : ''}.png`)
      await page.screenshot({ path: name('context'), clip: { x: 0, y: 0, width, height } })
      await setOrder(popup, false)
      await lookUp(page, hero, HERO_ABOVE)
      await page.screenshot({ path: name('dictionary'), clip: { x: 0, y: 0, width, height } })
      console.log(`lookup pictures${suffix || ' (wide)'}, ${scheme}: ${width} × ${height}`)
    }
  }
  await setOrder(popup, true)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 900, height: 760 })
}

/** The extension's window, in both colour schemes, with a page of Hamlet in the active tab. */
async function windows(context: BrowserContext, popup: Page) {
  const tab = await context.newPage()
  await tab.goto(HAMLET, { waitUntil: 'load' })
  await popup.setViewportSize({ width: 340, height: 700 })
  for (const scheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme: scheme })
    await popup.reload()
    await sleep(700)
    const height = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom))
    await popup.screenshot({ path: path.join(images, `window${scheme === 'dark' ? '-dark' : ''}.png`), clip: { x: 0, y: 0, width: 340, height } })
  }
  await tab.close()
}

/** The card shared on social networks (1200 × 630): the site's headline beside the capture of the lookup. */
async function social(context: BrowserContext) {
  const page = await context.newPage()
  await page.setViewportSize({ width: 600, height: 315 })
  await page.goto(`${origin}/try.html`)
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="${origin}/"><link rel="stylesheet" href="site.css"><style>
html { color-scheme: light } body { width: 600px; height: 315px; overflow: hidden; display: grid; grid-template-columns: 290px 1fr; background: #fbfaf7; color: #1a1d21 }
.text { padding: 34px 0 0 36px } .text .brand { font-size: 13px; gap: 7px } h1 { margin-top: 44px; font-size: 39px; line-height: 1.05 }
.text p { margin-top: 14px; font-size: 12.5px; line-height: 1.45; color: #555d68 }
.picture { margin: 30px 0 0 26px; width: 330px; border: 1px solid #dcd9cf; border-radius: 9px 0 0 0; overflow: hidden; box-shadow: 0 12px 32px rgb(26 29 33 / 12%) } .picture img { width: 600px; max-width: none; margin: -40px 0 0 -246px }
</style></head><body><div class="text"><span class="brand"><img src="images/icon-128.png" width="22" height="22" alt="">Contextual Dictionary</span><h1>What does this <mark>word</mark> mean <em>here?</em></h1><p>A free Chrome extension. The meaning that fits the sentence, first.</p></div>
<div class="picture"><img src="data:image/png;base64,${fs.readFileSync(path.join(images, 'lookup-context.png')).toString('base64')}" alt=""></div></body></html>`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await sleep(300)
  await page.screenshot({ path: path.join(images, 'social.png') })
  await page.close()
}

try {
  fs.mkdirSync(images, { recursive: true })
  const { context, popup } = await launch()
  for (const bundle of ['dictionary', 'model'] as const) {
    if ((await statusOf(popup)).bundles[bundle].phase === 'ready') continue
    await popup.locator(`[data-bundle="${bundle}"] [data-action="download"]`).click()
    await waitFor(popup, status => status.bundles[bundle].phase === 'ready', `the ${bundle}`)
    await popup.reload()
  }
  const page = await context.newPage()
  await page.goto(`${origin}/try.html`)
  await page.evaluate(() => document.fonts.ready)
  await sleep(500)
  await answers(popup, page)
  if (!process.argv.includes('--answers-only')) {
    await lookups(popup, page)
    await windows(context, popup)
    await social(context)
  }
  await context.close()
} finally {
  server.close()
  fs.rmSync(served, { recursive: true, force: true })
}
