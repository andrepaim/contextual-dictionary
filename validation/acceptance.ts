// Release acceptance on a fresh Chromium profile with the packaged ZIP
// (docs/plan.md section 10, docs/validation.md "Acceptance"). Uses the real
// release assets-v1 over the network, so it is opt-in and never part of CI.
//
//   npm run package
//   npx tsx validation/acceptance.ts [--zip package/contextual-dictionary-0.1.0.zip] [--public]
//
// 1. Unzips the package, loads it unpacked in a new profile, confirms both
//    downloads in the extension's own window, as a reader does.
// 2. Double-clicks "mouse" in "Drag the mouse to move the cursor on screen"
//    on a local page, with "Order by context" on and then off.
// 3. Goes offline and looks words up again.
// 4. Restarts the browser on the same profile: the files are still there,
//    and the first lookup is timed.
// 5. With --public, opens three public pages and double-clicks a few words
//    on each (a handful of page loads; no crawling).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import type { Status } from '../src/shared/contracts'
import { card, doubleClickWord, shownEntries } from '../test/e2e/support/card'
import { PATHS } from './common'

const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string
const { values } = parseArgs({ options: { zip: { type: 'string', default: `package/contextual-dictionary-${version}.zip` }, public: { type: 'boolean', default: false } } })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log: string[] = []
const note = (line: string) => { log.push(line); console.log(line) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-acceptance-'))
const extension = path.join(root, 'extension'), profile = path.join(root, 'profile')
fs.mkdirSync(extension)
execFileSync('unzip', ['-q', path.resolve(values.zip!), '-d', extension])
note(`package: ${values.zip} (${fs.statSync(values.zip!).size} bytes)`)

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acceptance</title></head><body>
<p id="mouse">Drag the mouse to move the cursor on screen.</p>
<p id="bank">She deposited the cheque at the bank on Monday morning before work.</p>
<p id="river">The children sat on the grassy bank of the river and watched the boats go by.</p></body></html>`
const server = http.createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE))
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const pageUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`

async function launch(): Promise<{ context: BrowserContext; id: string }> {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  return { context, id: new URL(worker.url()).host }
}
const statusOf = (page: Page) => page.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })).then(reply => (reply as { value: Status }).value)
async function waitFor(page: Page, test: (status: Status) => boolean, what: string, timeoutMs = 600_000) {
  const started = Date.now()
  for (;;) {
    const status = await statusOf(page)
    if (test(status)) return Date.now() - started
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(status.bundles)}`)
    await sleep(250)
  }
}
/** Double-clicks `word` in paragraph `id` and returns the time to the card and its entries. */
async function lookUp(page: Page, id: string, word: string) {
  await page.mouse.click(5, 5)
  const started = Date.now()
  await doubleClickWord(page.locator(`#${id}`), word)
  await card(page).waitFor({ state: 'visible', timeout: 10_000 })
  const ms = Date.now() - started
  const entries = await shownEntries(page)
  return { ms, entries }
}
const firstNoun = (entries: Awaited<ReturnType<typeof shownEntries>>, lemma: string) => entries.find(entry => entry.lemma === lemma && entry.pos === 'noun')?.definitions ?? []

try {
  // ------------------------------------------------------------ first run
  let { context, id } = await launch()
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  const before = await statusOf(popup)
  note(`fresh profile: dictionary ${before.bundles.dictionary.phase} (${before.bundles.dictionary.requiredBytes} bytes), model ${before.bundles.model.phase} (${before.bundles.model.requiredBytes} bytes), order by context ${before.settings.orderByContext}`)
  let started = Date.now()
  await popup.locator('[data-bundle="dictionary"] [data-action="download"]').click()
  await waitFor(popup, status => status.bundles.dictionary.phase === 'ready', 'the dictionary')
  note(`dictionary downloaded and installed through the popup in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  await popup.reload()
  started = Date.now()
  await popup.locator('[data-control="orderByContext"]').click()
  note(`consent: ${(await popup.locator('[data-part="consent"]').textContent())?.replace(/\s+/g, ' ').trim()}`)
  await popup.locator('[data-action="confirm-order"]').click()
  await waitFor(popup, status => status.bundles.model.phase === 'ready', 'the model')
  note(`model downloaded and installed through the popup in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  const readyMs = await waitFor(popup, status => status.ranker.state === 'ready', 'the model to load', 60_000)
  note(`model ready ${readyMs} ms after the install finished`)
  const installed = await statusOf(popup)
  note(`installed: dictionary ${installed.bundles.dictionary.storedBytes} bytes, model ${installed.bundles.model.storedBytes} bytes, order by context ${installed.settings.orderByContext}`)

  const page = await context.newPage()
  await page.goto(pageUrl)
  for (const attempt of [1, 2]) {
    const on = await lookUp(page, 'mouse', 'mouse')
    note(`ordering on, "mouse" (lookup ${attempt}): card in ${on.ms} ms; mouse (noun) meanings: ${firstNoun(on.entries, 'mouse').slice(0, 3).map(text => JSON.stringify(text.slice(0, 70))).join(' | ')}`)
  }
  for (const [paragraph, word] of [['bank', 'bank'], ['river', 'bank']] as const) {
    const answer = await lookUp(page, paragraph, word)
    note(`ordering on, "${word}" in #${paragraph}: card in ${answer.ms} ms; first bank (noun) meaning: ${JSON.stringify(firstNoun(answer.entries, 'bank')[0]?.slice(0, 80))}; entries: ${answer.entries.map(entry => `${entry.lemma}/${entry.pos}`).join(', ')}`)
  }
  await popup.reload()
  await popup.locator('[data-control="orderByContext"]').click()
  await sleep(300)
  const off = await lookUp(page, 'mouse', 'mouse')
  note(`ordering off, "mouse": card in ${off.ms} ms; mouse (noun) meanings: ${firstNoun(off.entries, 'mouse').slice(0, 3).map(text => JSON.stringify(text.slice(0, 70))).join(' | ')}`)
  await popup.locator('[data-control="orderByContext"]').click()
  await waitFor(popup, status => status.ranker.state === 'ready', 'the model to load again', 60_000)

  // --------------------------------------------------------------- offline
  await context.setOffline(true)
  const offline = await lookUp(page, 'bank', 'bank')
  note(`offline, "bank": card in ${offline.ms} ms with ${offline.entries.length} entries`)
  const offlineMouse = await lookUp(page, 'mouse', 'mouse')
  note(`offline, "mouse": first meaning ${JSON.stringify(firstNoun(offlineMouse.entries, 'mouse')[0]?.slice(0, 70))}`)
  await context.setOffline(false)
  await context.close()

  // --------------------------------------------------------------- restart
  ;({ context, id } = await launch())
  const again = await context.newPage()
  await again.goto(pageUrl)
  const restarted = await lookUp(again, 'bank', 'bank')
  note(`after a browser restart: first lookup, card in ${restarted.ms} ms with ${restarted.entries.length} entries`)
  const second = await lookUp(again, 'river', 'bank')
  note(`after a browser restart: second lookup, card in ${second.ms} ms`)
  const control = await context.newPage()
  await control.goto(`chrome-extension://${id}/popup.html`)
  const persisted = await statusOf(control)
  note(`after the restart: dictionary ${persisted.bundles.dictionary.phase}, model ${persisted.bundles.model.phase}, order by context ${persisted.settings.orderByContext}, ranker ${persisted.ranker.state}`)
  await waitFor(control, status => status.ranker.state === 'ready', 'the model after the restart', 60_000)
  const ordered = await lookUp(again, 'mouse', 'mouse')
  note(`after the restart, model ready: "mouse" first meaning ${JSON.stringify(firstNoun(ordered.entries, 'mouse')[0]?.slice(0, 70))}`)

  // ---------------------------------------------------------- public pages
  if (values.public) {
    const sites: Array<{ url: string; words: string[] }> = [
      { url: 'https://en.wikipedia.org/wiki/Computer_mouse', words: ['ball', 'button', 'wheel', 'pointer'] },
      { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Element/dblclick_event', words: ['fires', 'element', 'pointing', 'event'] },
      { url: 'https://blog.mozilla.org/en/', words: ['browser', 'privacy', 'web'] },
    ]
    for (const site of sites) {
      const tab = await context.newPage()
      try {
        const response = await tab.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        note(`${site.url}: HTTP ${response?.status()}`)
        await sleep(1500)
        for (const word of site.words) {
          // The first visible occurrence of the word as a whole word in running text.
          const found = await tab.evaluate(word => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const text = node.textContent ?? ''
              const match = new RegExp(`\\b${word}\\b`, 'i').exec(text)
              const parent = node.parentElement
              if (!match || !parent || parent.closest('script,style,nav,header,input,textarea,[contenteditable]')) continue
              const range = document.createRange()
              range.setStart(node, match.index); range.setEnd(node, match.index + word.length)
              const box = range.getBoundingClientRect()
              if (box.width === 0 || box.height === 0) continue
              parent.scrollIntoView({ block: 'center' })
              const after = range.getBoundingClientRect()
              return { x: after.left + after.width / 2, y: after.top + after.height / 2, context: text.slice(Math.max(0, match.index - 50), match.index + 50).replace(/\s+/g, ' ') }
            }
            return null
          }, word)
          if (!found) { note(`  "${word}": not found as visible text`); continue }
          await tab.mouse.click(2, 2)
          const clicked = Date.now()
          await tab.mouse.dblclick(found.x, found.y)
          const shown = await card(tab).waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
          if (!shown) { note(`  "${word}" in "…${found.context}…": no card within 5 s`); continue }
          const entries = await shownEntries(tab)
          note(`  "${word}" in "…${found.context}…": card in ${Date.now() - clicked} ms; ${entries.slice(0, 3).map(entry => `${entry.lemma}/${entry.pos}: ${JSON.stringify(entry.definitions[0]?.slice(0, 60))}`).join('; ')}`)
          await tab.keyboard.press('Escape')
        }
      } catch (error) {
        note(`${site.url}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      } finally {
        await tab.close()
      }
    }
  }
  await context.close()
} finally {
  server.close()
  fs.writeFileSync(path.join(PATHS.out, 'acceptance.log'), log.join('\n') + '\n')
  fs.rmSync(root, { recursive: true, force: true })
}
