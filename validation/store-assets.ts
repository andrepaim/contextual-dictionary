// Makes the Chrome Web Store images in store/ (see store/listing.md): five
// 1280 × 800 screenshots, the 440 × 280 and 1400 × 560 promotional tiles and
// the 128 × 128 store icon.
//
//   npm run build
//   npx tsx validation/store-assets.ts [--capture-only | --compose-only]
//
// The screenshots are real: the built extension in Chromium with the real
// dictionary and model (release assets-v1, downloaded once into a profile
// under ~/.cache/contextual-dictionary/store-profile), on
// shakespeare.mit.edu and on a small demonstration page. The captures are
// then set in a frame with a headline. Opt-in, never part of CI.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import type { Status } from '../src/shared/contracts'
import { doubleClickWord } from '../test/e2e/support/card'

const extension = path.resolve('dist')
const cache = path.join(os.homedir(), '.cache/contextual-dictionary')
const profile = path.join(cache, 'store-profile'), raw = path.join(cache, 'store-raw'), out = path.resolve('store')
for (const directory of [raw, out]) fs.mkdirSync(directory, { recursive: true })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const DEMO = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title><style>
:root { color-scheme: light dark; --page: #ffffff; --text: #1f2328; --muted: #59636e; --rule: #d1d9e0 }
@media (prefers-color-scheme: dark) { :root { --page: #0d1117; --text: #e6edf3; --muted: #9198a1; --rule: #3d444d } }
body { margin: 0; background: var(--page); color: var(--text); font: 18px/1.6 "Ubuntu Sans", "Ubuntu", system-ui, sans-serif }
main { max-width: 470px; margin: 0 0 0 56px; padding: 26px 0 }
h1 { font-size: 27px; line-height: 1.25; margin: 0 0 4px }
.by { color: var(--muted); font-size: 14px; margin: 0 0 14px; padding-bottom: 12px; border-bottom: 1px solid var(--rule) }
p { margin: 0 0 14px }
</style></head><body><main>
<h1>Notes from the workshop</h1><p class="by">A demonstration page</p>
<p id="mouse">Hold the button down and drag the mouse across the desk to move the cursor on screen.</p>
<p id="crane">By noon a crane had lifted the last steel beams onto the roof of the new library.</p>
<p id="bug">The release slipped a week because of a bug in the payment code that nobody could reproduce.</p>
<p id="cell">Each cell in the spreadsheet holds a formula that adds up the row above it.</p>
<p id="pitch">The founders had ten minutes to give their pitch to a room of tired investors.</p>
</main></body></html>`
const server = http.createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DEMO))
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const demoUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
const HAMLET = 'https://shakespeare.mit.edu/hamlet/hamlet.3.1.html'

async function launch(width: number, height: number, scale: number): Promise<{ context: BrowserContext; popup: Page }> {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width, height }, deviceScaleFactor: scale, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
  return { context, popup }
}
const statusOf = (popup: Page) => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })).then(reply => (reply as { value: Status }).value)
async function waitFor(popup: Page, test: (status: Status) => boolean, what: string) {
  for (const started = Date.now(); ;) {
    const status = await statusOf(popup)
    if (test(status)) return
    if (Date.now() - started > 600_000) throw new Error(`timed out waiting for ${what}`)
    await sleep(300)
  }
}
const setDetails = (popup: Page, on: boolean) => popup.evaluate(on => chrome.runtime.sendMessage({ type: 'set-settings', patch: { showOrderDetails: on } }), on).then(() => sleep(300))
/** What the card says about the order: the "was" tags and the status line (with "Show order details" on). */
const orderParts = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('contextual-dictionary-card')?.shadowRoot
  return { was: [...(root?.querySelectorAll('[data-part="was"]') ?? [])].map(node => node.textContent), status: root?.querySelector('[data-part="order-status"]')?.textContent ?? null }
})
async function setOrder(popup: Page, on: boolean) {
  await popup.evaluate(on => chrome.runtime.sendMessage({ type: 'set-settings', patch: { orderByContext: on } }), on)
  if (on) await waitFor(popup, status => status.ranker.state === 'ready' || status.ranker.state === 'idle', 'the model')
  await sleep(300)
}
const CARD = 'contextual-dictionary-card [data-part="card"]'
/** Double-clicks `word` in the element `selector`, `above` pixels below the top of the window, and waits for the final card. */
async function lookUp(page: Page, selector: string, word: string, above: number) {
  await page.keyboard.press('Escape')
  await page.mouse.click(2, 2)
  const element = page.locator(selector).first()
  await element.evaluate((node, above) => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -above) }, above)
  await sleep(200)
  await doubleClickWord(element, word)
  await page.locator(CARD).waitFor()
  await page.mouse.move(2, 300)
  await sleep(400)
  return page.locator(`${CARD} [data-part="definition"]`).first().textContent()
}
/** The lookup twice with ordering on: the second takes the model's answer when the first missed the time budget. */
async function ordered(page: Page, selector: string, word: string, above: number) {
  await lookUp(page, selector, word, above)
  await sleep(1500)
  return lookUp(page, selector, word, above)
}

async function capture() {
  // Page captures at 896 × 488, scaled 1.25: 1120 × 610 pixels, the size of the frame's window.
  let { context, popup } = await launch(896, 488, 1.25)
  let status = await statusOf(popup)
  if (status.bundles.dictionary.phase !== 'ready') {
    await popup.locator('[data-bundle="dictionary"] [data-action="download"]').click()
    await waitFor(popup, status => status.bundles.dictionary.phase === 'ready', 'the dictionary')
    await popup.reload()
  }
  status = await statusOf(popup)
  if (status.bundles.model.phase !== 'ready') {
    await popup.locator('[data-bundle="model"] [data-action="download"]').click()
    await waitFor(popup, status => status.bundles.model.phase === 'ready', 'the model')
  }
  await setOrder(popup, true)
  await setDetails(popup, false)
  const hamlet = await context.newPage()
  await hamlet.goto(HAMLET, { waitUntil: 'load' })
  await sleep(800)
  const line = 'a[name]:has-text("great pith and moment")'
  console.log('hamlet, by context:', await ordered(hamlet, line, 'moment', 76))
  await hamlet.screenshot({ path: path.join(raw, 'hamlet-context.png') })
  console.log('hamlet, details off:', JSON.stringify(await orderParts(hamlet)))
  await setDetails(popup, true)
  console.log('hamlet, details on:', await ordered(hamlet, line, 'moment', 76), JSON.stringify(await orderParts(hamlet)))
  await hamlet.screenshot({ path: path.join(raw, 'hamlet-details.png') })
  await setOrder(popup, false)
  await lookUp(hamlet, line, 'moment', 76)
  console.log('hamlet, details on, ordering off:', JSON.stringify(await orderParts(hamlet)))
  await setOrder(popup, true)
  await setDetails(popup, false)
  const demo = await context.newPage()
  await demo.goto(demoUrl)
  await sleep(500)
  for (const word of ['mouse', 'crane', 'bug']) {
    console.log(`demo ${word}, by context:`, await ordered(demo, `#${word}`, word, word === 'mouse' ? 118 : 60))
    await demo.screenshot({ path: path.join(raw, `demo-${word}.png`) })
  }
  await context.close()

  // The two cards and the extension's window, scaled 2 for sharp details.
  ;({ context, popup } = await launch(700, 900, 2))
  const page = await context.newPage()
  await page.goto(HAMLET, { waitUntil: 'load' })
  await sleep(800)
  // The first lookup after a browser start: the model is not loaded yet.
  await setDetails(popup, true)
  await lookUp(page, line, 'moment', 76)
  console.log('first lookup after a start, details on:', JSON.stringify(await orderParts(page)))
  await setDetails(popup, false)
  await setOrder(popup, true)
  console.log('card, by context:', await ordered(page, line, 'moment', 76))
  await page.locator(CARD).screenshot({ path: path.join(raw, 'card-context.png') })
  await setOrder(popup, false)
  console.log('card, dictionary order:', await lookUp(page, line, 'moment', 76))
  await page.locator(CARD).screenshot({ path: path.join(raw, 'card-dictionary.png') })
  await setOrder(popup, true)
  await popup.setViewportSize({ width: 380, height: 700 })
  await popup.reload()
  await sleep(600)
  const box = await popup.evaluate(() => { const rect = document.body.getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(rect.right + rect.left), height: Math.ceil(rect.bottom + rect.top) } })
  await popup.screenshot({ path: path.join(raw, 'popup.png'), clip: box })
  await context.close()
}

// ------------------------------------------------------------- composition

const BLUE = '#0969da'
/** The extension's icon (scripts/make-icons.mjs) as SVG: `tile` draws the blue tile, otherwise only the book in `ink` on `paper`. */
function bookSvg(size: number, { tile = true, ink = BLUE, paper = '#ffffff' } = {}): string {
  const left = (x: number) => 0.30 + 0.2 * (x - 0.18), right = (x: number) => 0.36 - 0.2 * (x - 0.52)
  const band = (top: (x: number) => number, from: number, to: number, start: number, end: number) =>
    `${from},${top(from) + start} ${to},${top(to) + start} ${to},${top(to) + end} ${from},${top(from) + end}`
  const lines = [0.12, 0.22, 0.32].map(depth => `<polygon points="${band(left, 0.22, 0.46, depth - 0.018, depth + 0.018)}"/><polygon points="${band(right, 0.54, 0.78, depth - 0.018, depth + 0.018)}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1 1">${tile ? `<rect x="0.04" y="0.04" width="0.92" height="0.92" rx="0.2" fill="${ink}"/>` : ''}
<g fill="${paper}"><polygon points="${band(left, 0.18, 0.48, 0, 0.40)}"/><polygon points="${band(right, 0.52, 0.82, 0, 0.40)}"/></g><g fill="${ink}">${lines}</g></svg>`
}
const image = (name: string) => `data:image/png;base64,${fs.readFileSync(path.join(raw, name)).toString('base64')}`
const STYLE = `
* { box-sizing: border-box } html, body { margin: 0 }
body { font-family: "Ubuntu Sans", "Ubuntu", system-ui, sans-serif; color: #0b1f3a; -webkit-font-smoothing: antialiased }
.shot { width: 1280px; height: 800px; background: linear-gradient(160deg, #f4f8fe 0%, #dbe9fb 100%); position: relative; overflow: hidden }
h1 { position: absolute; left: 80px; right: 80px; top: 34px; margin: 0; font-size: 46px; line-height: 56px; font-weight: 700; letter-spacing: -0.5px }
.sub { position: absolute; left: 80px; right: 80px; top: 98px; margin: 0; font-size: 23px; line-height: 32px; color: #3f5573 }
.window { position: absolute; left: 80px; top: 150px; width: 1120px; height: 610px; border-radius: 14px; overflow: hidden; background: #fff; border: 1px solid #c3d3e8; box-shadow: 0 18px 50px rgba(11, 31, 58, .18) }
.window img { display: block; width: 1120px; height: 610px }
`
/** A captured card (taken at scale 2, with its own border) shown `width` pixels wide, its corners cut at the card's own 10-pixel radius. */
function cardImage(name: string, width: number, style = 'box-shadow: 0 14px 40px rgba(11, 31, 58, .2)'): string {
  const captured = fs.readFileSync(path.join(raw, name)).readUInt32BE(16) / 2
  return `<img src="${image(name)}" style="display:block;width:${width}px;border-radius:${(10 * width / captured).toFixed(1)}px;${style}">`
}
interface Piece { file: string; width: number; height: number; html: string; transparent?: boolean }
const framed = (file: string, headline: string, sub: string, capture: string): Piece => ({ file, width: 1280, height: 800, html: `<div class="shot"><h1>${headline}</h1><p class="sub">${sub}</p><div class="window"><img src="${image(capture)}"></div></div>` })

function pieces(): Piece[] {
  const compare = `<div class="shot"><h1>Same word, same dictionary, a better order</h1>
<p class="sub">“And enterprises of great pith and <b style="color:${BLUE}">moment</b>” — Hamlet, act 3, scene 1</p>
<style>.col { position: absolute; top: 160px; width: 470px } .col h2 { margin: 0 0 12px; font-size: 24px; line-height: 32px } 
.arrow { position: absolute; left: 610px; top: 400px; width: 60px; font-size: 60px; line-height: 60px; text-align: center; color: ${BLUE} }</style>
<div class="col" style="left: 110px"><h2 style="color:#59636e">Dictionary order</h2>${cardImage('card-dictionary.png', 470)}</div>
<div class="arrow">→</div>
<div class="col" style="left: 700px"><h2 style="color:${BLUE}">Ordered by context</h2>${cardImage('card-context.png', 470)}</div></div>`
  const privacy = `<div class="shot"><style>.popup { position: absolute; left: 110px; top: 70px; height: 660px; border-radius: 14px; border: 1px solid #c3d3e8; box-shadow: 0 18px 50px rgba(11, 31, 58, .18) }
.text { position: absolute; left: 600px; right: 80px; top: 150px } .text h1 { position: static; font-size: 50px; line-height: 60px; margin: 0 0 30px }
.text li { font-size: 26px; line-height: 36px; margin: 0 0 22px; color: #263b58 } .text ul { margin: 0; padding-left: 28px } .text li::marker { color: ${BLUE} }</style>
<img class="popup" src="${image('popup.png')}">
<div class="text"><h1>Private by design</h1><ul><li>The dictionary and the model run on your computer.</li><li>What you select is never sent anywhere.</li><li>No account, no analytics, no tracking.</li><li>Works offline after two downloads that you confirm.</li></ul></div></div>`
  const tile = (width: number, height: number, inner: string) => `<div style="width:${width}px;height:${height}px;background:linear-gradient(150deg,#1f7ae6 0%,#0969da 45%,#0550ae 100%);color:#fff;position:relative;overflow:hidden">${inner}</div>`
  const small = tile(440, 280, `<div style="position:absolute;left:0;right:0;top:34px;text-align:center">${bookSvg(104, { tile: false })}</div>
<div style="position:absolute;left:0;right:0;top:146px;text-align:center;font-size:34px;line-height:42px;font-weight:700;letter-spacing:-0.3px">Contextual Dictionary</div>
<div style="position:absolute;left:0;right:0;top:196px;text-align:center;font-size:19px;line-height:28px;color:#d6e8ff">The meaning that fits the sentence, first</div>`)
  const marquee = tile(1400, 560, `<div style="position:absolute;left:110px;top:120px">${bookSvg(150, { tile: false })}</div>
<div style="position:absolute;left:110px;top:282px;font-size:66px;line-height:76px;font-weight:700;letter-spacing:-1px">Contextual Dictionary</div>
<div style="position:absolute;left:112px;top:372px;font-size:30px;line-height:40px;color:#d6e8ff">The meaning that fits the sentence, first.<br>Private, offline, on your computer.</div>
<div style="position:absolute;left:900px;top:70px;transform:rotate(2deg)">${cardImage('card-context.png', 400, 'box-shadow: 0 24px 60px rgba(0, 0, 0, .35)')}</div>`)
  return [
    framed('screenshot-1-context.png', 'The meaning that fits the sentence comes first', 'Hamlet’s “great pith and moment” means importance, not a point in time.', 'hamlet-context.png'),
    { file: 'screenshot-2-compare.png', width: 1280, height: 800, html: compare },
    framed('screenshot-3-any-page.png', 'Double-click any word on any page', 'Three meanings at a glance, with examples. One click shows the rest.', 'demo-mouse.png'),
    framed('screenshot-4-details.png', 'See what the model changed', 'With “Show order details” on, each meaning says where the dictionary had it.', 'hamlet-details.png'),
    { file: 'screenshot-5-private.png', width: 1280, height: 800, html: privacy },
    { file: 'promo-small-440x280.png', width: 440, height: 280, html: small },
    { file: 'promo-marquee-1400x560.png', width: 1400, height: 560, html: marquee },
    // The store asks for 96 × 96 artwork with 16 pixels of transparent padding on each side.
    { file: 'icon-128.png', width: 128, height: 128, transparent: true, html: `<div style="width:128px;height:128px;padding:14px">${bookSvg(100)}</div>` },
  ]
}

async function compose() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  for (const piece of pieces()) {
    const page = await browser.newPage({ viewport: { width: piece.width, height: piece.height }, deviceScaleFactor: 1 })
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${STYLE}${piece.transparent ? 'html, body { background: transparent }' : ''}</style>${piece.html}`, { waitUntil: 'load' })
    await page.screenshot({ path: path.join(out, piece.file), omitBackground: piece.transparent === true })
    await page.close()
    console.log(`store/${piece.file} (${piece.width} × ${piece.height})`)
  }
  await browser.close()
}

try {
  if (!process.argv.includes('--compose-only')) await capture()
  if (!process.argv.includes('--capture-only')) await compose()
} finally {
  server.close()
}
