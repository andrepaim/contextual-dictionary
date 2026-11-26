// Makes the short film of the running extension that the project site shows
// (site/media/contextual-dictionary.webm) and its opening picture
// (site/images/film.png).
//
//   npm run build
//   npx tsx validation/site-video.ts [--compose-only]
//
// The film is a recording, not a drawing: the built extension in Chromium with
// the real dictionary and model (the profile that validation/store-assets.ts
// fills), looking words up on the site's own practice page, served from this
// computer. The window is captured picture by picture while a real pointer
// moves, double-clicks and scrolls, at the speed it happened. Around the
// recording the film adds only a headline, a drawn pointer where the real one
// was (a headless browser paints none), and an opening and a closing card.
// Every lookup is checked against the answer in site/_examples.json; a lookup
// that shows another first meaning stops the run. Opt-in, never part of CI.
//
// Needs the ffmpeg that Playwright installs (npx playwright install chromium),
// or another one named in CD_FFMPEG. Captures take the fonts of the machine
// they run on: see validation/site-assets.ts.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Locator, type Page } from '@playwright/test'
// @ts-expect-error plain JavaScript build script without types
import { copyStatic, readExamples, renderPage } from '../scripts/build-site.mjs'
import type { Status } from '../src/shared/contracts'
import { wordBox } from '../test/e2e/support/card'

interface Example { id: string; word: string; result?: { context: { first: string; was?: number } } }
interface Examples { extension: string; examples: Example[] }
/** What was recorded: the pictures of the window, where the pointer was, where it clicked and when each headline starts, in milliseconds from the start. */
interface Take {
  length: number
  frames: { at: number; file: string }[]
  pointer: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number }[]
  cues: { at: number; caption: number }[]
  lookups: { word: string; first: string; ms: number }[]
}

const extension = path.resolve('dist')
const cache = path.join(os.homedir(), '.cache/contextual-dictionary')
const profile = path.join(cache, 'store-profile'), raw = path.join(cache, 'video-raw')
const film = path.resolve('site/media/contextual-dictionary.webm'), poster = path.resolve('site/images/film.png')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const CARD = 'contextual-dictionary-card [data-part="card"]'
const HAMLET = 'https://shakespeare.mit.edu/hamlet/hamlet.3.1.html'
/** The recorded window in CSS pixels, captured at 11 pixels to 6 (1760 × 902); the film is 1920 × 1080 at 30 pictures a second. */
const VIEW = { width: 960, height: 492 }, SCALE = 11 / 6, FILM = { width: 1920, height: 1080 }, RATE = 30
const WINDOW = { left: 80, top: 142 }

const data = readExamples() as Examples
const example = (id: string) => data.examples.find(example => example.id === id)!
const ordinal = (place: number) => `${place}${place % 10 === 1 && place % 100 !== 11 ? 'st' : place % 10 === 2 && place % 100 !== 12 ? 'nd' : place % 10 === 3 && place % 100 !== 13 ? 'rd' : 'th'}`
/** The headlines above the window: a title and a line under it. */
const CAPTIONS: [string, string][] = [
  ['Double-click a word on any page', 'A card opens with its meanings from the English Wiktionary.'],
  ['The meaning that fits the sentence comes first', `Hamlet means importance. The dictionary lists that meaning ${ordinal(example('hamlet').result!.context.was!)}.`],
  ['The same word in another sentence', 'A small model on your computer reads the sentence around the word.'],
  ['Three meanings at a glance', 'One click shows the rest, and nothing is left out.'],
]

// The site, with its practice page, on a local address.
const served = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-site-video-'))
copyStatic(served)
fs.writeFileSync(path.join(served, 'try.html'), renderPage('try.html', data))
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' }
const server = http.createServer((request, response) => {
  const name = path.normalize(new URL(request.url ?? '/', 'http://x').pathname)
  const file = name.startsWith('/raw/') ? path.join(raw, path.basename(name)) : path.join(served, name)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void response.writeHead(404).end()
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

// ------------------------------------------------------------------ recording

async function launch(): Promise<{ context: BrowserContext; popup: Page }> {
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: VIEW, deviceScaleFactor: SCALE, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
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
const firstMeaning = (page: Page) => page.locator(`${CARD} [data-part="definition"]`).first().textContent()

/** Records the window of `page` while the pointer is driven through it. */
class Recorder {
  readonly take: Take = { length: 0, frames: [], pointer: [], clicks: [], cues: [], lookups: [] }
  private started = 0
  private running = false
  private loop: Promise<void> = Promise.resolve()
  private quiet = false
  private shot: Promise<unknown> = Promise.resolve()
  constructor(private readonly page: Page, private x: number, private y: number) {}
  private now() { return performance.now() - this.started }

  async start() {
    await this.page.mouse.move(this.x, this.y)
    this.started = performance.now()
    this.running = true
    this.take.pointer.push({ at: 0, x: this.x, y: this.y })
    this.loop = (async () => {
      for (let last: Buffer = Buffer.alloc(0); this.running;) {
        if (this.quiet) { await sleep(4); continue }
        const at = this.now()
        // The window as it is: the caret and the animations are left alone.
        const shot = this.page.screenshot({ caret: 'initial', animations: 'allow' })
        this.shot = shot
        const bytes = await shot
        if (bytes.equals(last)) { await sleep(8); continue }
        const file = `frame-${String(this.take.frames.length).padStart(4, '0')}.png`
        if (bytes.readUInt32BE(16) !== Math.round(VIEW.width * SCALE) || bytes.readUInt32BE(20) !== Math.round(VIEW.height * SCALE)) throw new Error(`a picture of ${bytes.readUInt32BE(16)} × ${bytes.readUInt32BE(20)}`)
        fs.writeFileSync(path.join(raw, file), bytes)
        this.take.frames.push({ at, file })
        last = bytes
      }
    })()
    await sleep(120)
  }
  async stop(): Promise<Take> {
    this.running = false
    await this.loop
    this.take.length = this.now()
    return this.take
  }
  cue(caption: number) { this.take.cues.push({ at: this.now(), caption }) }
  /** Runs `act` while no picture is being taken: a click or a turn of the wheel that falls inside a capture can land beside the pointer. */
  private async undisturbed<T>(act: () => Promise<T>): Promise<T> {
    this.quiet = true
    await this.shot
    try { return await act() } finally { this.quiet = false }
  }
  /** Moves the pointer to a place in the window, slowing at both ends, as a hand does. */
  async moveTo(x: number, y: number, ms = 800) {
    const fromX = this.x, fromY = this.y, begun = this.now()
    for (;;) {
      const part = Math.min(1, (this.now() - begun) / ms), eased = part < 0.5 ? 2 * part * part : 1 - (-2 * part + 2) ** 2 / 2
      this.x = fromX + (x - fromX) * eased
      this.y = fromY + (y - fromY) * eased
      await this.page.mouse.move(this.x, this.y)
      this.take.pointer.push({ at: this.now(), x: this.x, y: this.y })
      if (part === 1) return
      await sleep(12)
    }
  }
  private async centre(target: Locator, word?: string) {
    const box = (await target.boundingBox())!, inside = word ? await wordBox(target, word) : { x: 0, y: 0, width: box.width, height: box.height }
    return { x: box.x + inside.x + inside.width / 2, y: box.y + inside.y + inside.height / 2 }
  }
  /** The reader's double-click on the example's word; waits for the card and checks its first meaning against the recorded answer. */
  async lookUp(id: string, travel = 900) {
    const { word, result } = example(id), at = await this.centre(this.page.locator(`#${id} p`), word)
    await this.moveTo(at.x, at.y + 3, travel)
    await sleep(180)
    const clicked = this.now()
    this.take.clicks.push({ at: clicked, x: this.x, y: this.y })
    await this.undisturbed(() => this.page.mouse.dblclick(this.x, this.y))
    await this.page.locator(CARD).waitFor()
    const ms = Math.round(this.now() - clicked), first = (await firstMeaning(this.page)) ?? ''
    this.take.lookups.push({ word, first, ms })
    if (first !== result!.context.first) throw new Error(`"${word}" in ${id} opened on "${first}", not on "${result!.context.first}"`)
    // The hand moves off the word, so that it can be read.
    await sleep(350)
    await this.moveTo(at.x + 70, at.y - 24, 450)
  }
  async click(target: Locator, travel = 700) {
    const at = await this.centre(target)
    await this.moveTo(at.x, at.y, travel)
    await sleep(160)
    this.take.clicks.push({ at: this.now(), x: this.x, y: this.y })
    await this.undisturbed(() => this.page.mouse.click(this.x, this.y))
  }
  /** Scrolls the page with the wheel until the example's passage is at the top of the window. */
  async scrollTo(id: string, ms = 900) {
    const distance = await this.page.locator(`#${id}`).evaluate(node => node.closest('article')!.getBoundingClientRect().top - 8)
    await this.wheel(distance, ms)
    await sleep(450)
  }
  /** Turns the wheel under the pointer by `distance` pixels over `ms`. */
  async wheel(distance: number, ms: number) {
    const begun = this.now()
    for (let done = 0; ;) {
      const part = Math.min(1, (this.now() - begun) / ms), to = Math.round(distance * (part < 0.5 ? 2 * part * part : 1 - (-2 * part + 2) ** 2 / 2))
      // Each turn waits for the picture being taken, so that it reaches what is under the pointer.
      if (to !== done) await this.undisturbed(() => this.page.mouse.wheel(0, to - done))
      done = to
      if (part === 1) return
      await sleep(12)
    }
  }
  async closeCard() {
    await this.page.keyboard.press('Escape')
    await this.page.locator(CARD).waitFor({ state: 'detached' })
  }
}

async function record(): Promise<void> {
  fs.rmSync(raw, { recursive: true, force: true })
  fs.mkdirSync(raw, { recursive: true })
  const { context, popup } = await launch()
  for (const bundle of ['dictionary', 'model'] as const) {
    if ((await statusOf(popup)).bundles[bundle].phase === 'ready') continue
    await popup.locator(`[data-bundle="${bundle}"] [data-action="download"]`).click()
    await waitFor(popup, status => status.bundles[bundle].phase === 'ready', `the ${bundle}`)
    await popup.reload()
  }
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'set-settings', patch: { orderByContext: true, showOrderDetails: false } }))
  const page = await context.newPage()
  await page.goto(`${origin}/try.html`)
  await page.evaluate(() => document.fonts.ready)

  // Before the recording: a first lookup elsewhere on the page starts the model, as the first lookup of a browser session does.
  const top = (id: string) => page.locator(`#${id}`).evaluate(node => node.closest('article')!.getBoundingClientRect().top + window.scrollY)
  await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), await top('laboratory') - 40)
  const warm = await wordBox(page.locator('#laboratory p'), 'culture'), box = (await page.locator('#laboratory p').boundingBox())!
  await page.mouse.dblclick(box.x + warm.x + warm.width / 2, box.y + warm.y + warm.height / 2)
  await page.locator(CARD).waitFor()
  await waitFor(popup, status => status.ranker.state === 'ready', 'the model')
  await page.keyboard.press('Escape')
  await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), await top('hamlet') + 14)
  await page.mouse.click(2, 2)
  await sleep(600)

  const recorder = new Recorder(page, 700, 400)
  await recorder.start()
  recorder.cue(0)
  await sleep(900)
  await recorder.lookUp('hamlet', 1100)
  await sleep(1300)
  recorder.cue(1)
  await sleep(3000)

  await recorder.closeCard()
  recorder.cue(2)
  await recorder.moveTo(760, 330, 500)
  await recorder.scrollTo('concert')
  await recorder.lookUp('concert')
  await sleep(2700)
  await recorder.closeCard()
  await recorder.scrollTo('wiring', 700)
  await recorder.lookUp('wiring', 800)
  await sleep(2600)

  recorder.cue(3)
  await sleep(900)
  await recorder.click(page.locator(`${CARD} [data-part="toggle"]`))
  await sleep(900)
  const card = (await page.locator(CARD).boundingBox())!
  await recorder.moveTo(card.x + card.width * 0.6, card.y + card.height * 0.5, 600)
  // The wheel turns the list of meanings to its end and no further, so the page stays where it is.
  const hidden = await page.locator(CARD).evaluate(node => Math.max(0, ...[node, ...node.querySelectorAll('*')].map(part => getComputedStyle(part).overflowY === 'auto' ? part.scrollHeight - part.clientHeight : 0)))
  const before = await page.evaluate(() => window.scrollY)
  await recorder.wheel(Math.min(hidden, 900), 2200)
  if (hidden < 100 || await page.evaluate(() => window.scrollY) !== before) throw new Error(`the wheel was to turn the list of meanings by ${hidden} pixels and turned the page`)
  await sleep(1600)
  const take = await recorder.stop()
  fs.writeFileSync(path.join(raw, 'take.json'), JSON.stringify(take))
  for (const lookup of take.lookups) console.log(`${lookup.word}: card after ${lookup.ms} ms, opens on "${lookup.first}"`)
  console.log(`recorded ${(take.length / 1000).toFixed(1)} s in ${take.frames.length} pictures`)

  // The extension's window, with a page of Hamlet in the active tab.
  const tab = await context.newPage()
  await tab.goto(HAMLET, { waitUntil: 'load' })
  await popup.setViewportSize({ width: 340, height: 700 })
  await popup.reload()
  await sleep(700)
  const height = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom))
  await popup.screenshot({ path: path.join(raw, 'window.png'), clip: { x: 0, y: 0, width: 340, height } })
  await context.close()
}

// ---------------------------------------------------------------- composition

/** The stage of the film: the headline, the recorded window with the pointer, and the three cards that are not recordings. */
const stage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="${origin}/"><link rel="stylesheet" href="site.css"><style>
html { color-scheme: light } html, body { margin: 0; width: ${FILM.width}px; height: ${FILM.height}px; overflow: hidden; background: #fbfaf7; color: #1a1d21 }
.caption { position: absolute; left: ${WINDOW.left}px; right: ${WINDOW.left}px; top: 0 }
.caption h1 { position: absolute; left: 0; top: 20px; margin: 0; font: 500 58px/68px var(--serif); letter-spacing: -.02em; white-space: nowrap }
.caption p { position: absolute; left: 2px; top: 90px; margin: 0; font: 400 27px/36px var(--sans); color: #555d68; white-space: nowrap }
.window { position: absolute; left: ${WINDOW.left}px; top: ${WINDOW.top}px; width: ${VIEW.width * SCALE}px; height: ${VIEW.height * SCALE}px; border-radius: 16px; overflow: hidden; background: #fff; outline: 1px solid #dcd9cf; box-shadow: 0 2px 4px rgb(26 29 33 / 6%), 0 24px 64px rgb(26 29 33 / 12%) }
.window img { display: block; width: 100%; height: 100%; max-width: none }
#pointer { position: absolute; left: 0; top: 0; width: 44px; height: 44px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 35%)) }
#ring { position: absolute; left: 0; top: 0; width: 0; height: 0; border-radius: 50%; border: 5px solid #1b66d2 }
.card { position: absolute; inset: 0; background: #fbfaf7; display: grid; place-content: center; justify-items: center; text-align: center }
.card .name { display: flex; align-items: center; gap: 30px; font: 500 112px/1.1 var(--serif); letter-spacing: -.025em }
.card .name img { width: 112px; height: 112px }
.card p { margin: 34px 0 0; font: 400 42px/1.3 var(--sans); color: #555d68 }
.card p.address { margin-top: 20px; font-size: 32px; color: #0b5cc4 }
#private { display: block } #private img { position: absolute; left: 250px; top: 50%; width: 476px; max-width: none; transform: translateY(-50%); border-radius: 18px; outline: 1px solid #dcd9cf; box-shadow: 0 2px 4px rgb(26 29 33 / 6%), 0 24px 64px rgb(26 29 33 / 12%) }
#private div { position: absolute; left: 880px; right: 140px; top: 50%; transform: translateY(-50%); text-align: left }
#private h1 { margin: 0 0 44px; font: 500 84px/1.08 var(--serif); letter-spacing: -.02em }
#private li { margin: 0 0 24px; font: 400 36px/1.4 var(--sans); color: #3a4048 } #private ul { margin: 0; padding-left: 40px } #private li::marker { color: #0b5cc4 }
</style></head><body>
<div class="caption"><h1 id="title"></h1><p id="line"></p></div>
<div class="window"><img id="frame" alt=""></div>
<svg id="pointer" viewBox="0 0 22 22"><path d="M3 1.5v16.2l4.3-3.9 2.9 6.4 2.7-1.2-2.9-6.3h5.9z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>
<div id="ring"></div>
<div class="card" id="private"><img src="raw/window.png" alt=""><div><h1>It all runs on your computer</h1><ul><li>The dictionary and the model are on your disk.</li><li>What you select is never sent anywhere.</li><li>No account, no analytics, no tracking.</li><li>It works offline after two downloads.</li></ul></div></div>
<div class="card" id="opening"><div class="name"><img src="images/icon-128.png" alt="">Contextual Dictionary</div><p>The meaning that fits the sentence, first.</p></div>
<div class="card" id="closing"><div class="name"><img src="images/icon-128.png" alt="">Contextual Dictionary</div><p>Free for Chrome, in the Chrome Web Store.</p><p class="address">andrepaim.github.io/contextual-dictionary</p></div>
<script>
const $ = id => document.getElementById(id)
// Draws one picture of the film; resolves when the recorded picture it names is decoded.
window.draw = async state => {
  for (const id of ['opening', 'private', 'closing']) { $(id).style.opacity = state[id]; $(id).style.visibility = state[id] > 0 ? 'visible' : 'hidden' }
  $('title').textContent = state.caption[0]; $('line').textContent = state.caption[1]
  $('title').style.opacity = $('line').style.opacity = state.captionShown
  $('pointer').style.transform = 'translate(' + (state.pointer.x - 6) + 'px,' + (state.pointer.y - 3) + 'px)'
  const ring = $('ring'), size = state.ring ? 30 + 70 * state.ring.part : 0
  ring.style.visibility = state.ring ? 'visible' : 'hidden'
  if (state.ring) Object.assign(ring.style, { width: size + 'px', height: size + 'px', transform: 'translate(' + (state.ring.x - size / 2 - 5) + 'px,' + (state.ring.y - size / 2 - 5) + 'px)', opacity: 0.8 * (1 - state.ring.part) })
  const frame = $('frame')
  if (frame.dataset.file !== state.frame) { frame.dataset.file = state.frame; frame.src = 'raw/' + state.frame; await frame.decode() }
}
</script></body></html>`

const clamp = (value: number) => Math.max(0, Math.min(1, value))
/** How visible something is at `at` when it fades in from `from` and out before `to`. */
const shown = (at: number, from: number, to: number, fade = 300) => clamp(Math.min((at - from) / fade, (to - at) / fade))

function ffmpeg(): string {
  if (process.env.CD_FFMPEG) return process.env.CD_FFMPEG
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache/ms-playwright')
  const installed = fs.existsSync(browsers) ? fs.readdirSync(browsers).filter(name => name.startsWith('ffmpeg-')).sort().map(name => path.join(browsers, name, 'ffmpeg-linux')).filter(file => fs.existsSync(file)) : []
  return installed.at(-1) ?? 'ffmpeg'
}

async function compose(): Promise<void> {
  const take = JSON.parse(fs.readFileSync(path.join(raw, 'take.json'), 'utf8')) as Take
  // The film: the opening card, the recording, the extension's window, the closing card.
  const OPENING = 2100, PRIVATE = 3900, CLOSING = 3200
  const recording = OPENING - 300, window = recording + take.length - 300, closing = window + PRIVATE - 300, length = closing + CLOSING
  const pictures = Math.round(length / 1000 * RATE)

  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  const page = await browser.newPage({ viewport: FILM, deviceScaleFactor: 1 })
  await page.goto(`${origin}/try.html`)
  await page.setContent(stage(), { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)

  fs.mkdirSync(path.dirname(film), { recursive: true })
  const encoder = spawn(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(RATE), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-deadline', 'good', '-cpu-used', '1', '-row-mt', '1', '-g', String(RATE * 8), '-pix_fmt', 'yuv420p', '-an', film], { stdio: ['pipe', 'inherit', 'inherit'] })
  const encoded = new Promise<void>((resolve, reject) => encoder.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ended with ${code}`))).on('error', reject))

  const posterAt = recording + (take.cues.find(cue => cue.caption === 1)?.at ?? 0) + 1200
  let frame = 0, mark = 0, cue = 0
  for (let picture = 0; picture < pictures; picture++) {
    const at = picture * 1000 / RATE, local = Math.max(0, Math.min(take.length, at - recording))
    while (frame + 1 < take.frames.length && take.frames[frame + 1]!.at <= local) frame++
    while (mark + 1 < take.pointer.length && take.pointer[mark + 1]!.at <= local) mark++
    while (cue + 1 < take.cues.length && take.cues[cue + 1]!.at <= local) cue++
    const here = take.pointer[mark]!, next = take.pointer[mark + 1] ?? here, between = next.at > here.at ? clamp((local - here.at) / (next.at - here.at)) : 0
    const click = take.clicks.find(click => local >= click.at && local < click.at + 420)
    const sinceCue = local - take.cues[cue]!.at, untilCue = (take.cues[cue + 1]?.at ?? Infinity) - local
    const place = (x: number, y: number) => ({ x: WINDOW.left + x * SCALE, y: WINDOW.top + y * SCALE })
    await page.evaluate(state => (globalThis as unknown as { draw(state: unknown): Promise<void> }).draw(state), {
      opening: shown(at, -1000, OPENING), private: shown(at, window, window + PRIVATE), closing: shown(at, closing, length + 1000),
      caption: CAPTIONS[take.cues[cue]!.caption]!, captionShown: clamp(Math.min(sinceCue / 220, untilCue / 160)),
      frame: take.frames[frame]!.file,
      pointer: place(here.x + (next.x - here.x) * between, here.y + (next.y - here.y) * between),
      ring: click ? { ...place(click.x, click.y), part: (local - click.at) / 420 } : null,
    })
    encoder.stdin.write(await page.screenshot({ type: 'jpeg', quality: 100 }))
    if (Math.abs(at - posterAt) < 500 / RATE) await page.screenshot({ path: poster })
  }
  encoder.stdin.end()
  await encoded
  await browser.close()
  console.log(`site/media/${path.basename(film)}: ${(length / 1000).toFixed(1)} s, ${FILM.width} × ${FILM.height}, ${(fs.statSync(film).size / 1e6).toFixed(1)} MB; site/images/${path.basename(poster)}`)
}

try {
  if (!process.argv.includes('--compose-only')) await record()
  await compose()
} finally {
  server.close()
  fs.rmSync(served, { recursive: true, force: true })
}
