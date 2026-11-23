import { expect, test } from '@playwright/test'
import { card, cardHost, doubleClickWord, meanings } from './support/card'
import { MOUSE_CONTEXT_ORDER } from './support/assets'
import { closeOffscreen, install, launch, offscreenOpen, requestCounts, send, status, stopServiceWorker, type Session } from './support/extension'

let session: Session
test.afterEach(async () => { await session?.close() })

test('a page load asks for the status without starting the offscreen document', async () => {
  session = await launch({ control: false })
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/frames.html`)
  await expect(page.locator('html')).toHaveAttribute('data-contextual-dictionary', 'loaded')
  // The top page and its frame each asked once.
  await expect.poll(async () => (await requestCounts(session)).status).toBe(2)
  expect(await offscreenOpen(session)).toBe(false)
  // The first lookup is the first real need.
  await doubleClickWord(page.locator('#top'), 'bank')
  await expect.poll(() => offscreenOpen(session)).toBe(true)
  await expect(cardHost(page)).toBeHidden()
})

test('lookups keep working after the service worker is stopped, with ordering intact', async () => {
  session = await launch()
  await install(session, 'dictionary', 'model')
  expect((await send(session.control, { type: 'set-settings', patch: { orderByContext: true } })).ok).toBe(true)
  await expect.poll(async () => (await status(session.control)).ranker.state).toBe('ready')
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/article.html`)
  await stopServiceWorker(session)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_CONTEXT_ORDER)
  // A new service worker answered: its counts started again.
  expect(await requestCounts(session)).toMatchObject({ define: 1 })
})

test('lookups keep working after the offscreen document is closed', async () => {
  session = await launch()
  await install(session, 'dictionary')
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/article.html`)
  await closeOffscreen(session)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  expect(await offscreenOpen(session)).toBe(true)
  // And the downloaded files were found again by the new document.
  expect((await status(session.control)).bundles.dictionary.phase).toBe('ready')
})

test('a frame gets its own card', async () => {
  session = await launch()
  await install(session, 'dictionary')
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/frames.html`)
  const frame = page.frameLocator('#frame')
  await doubleClickWord(frame.locator('#framed'), 'mouse')
  await expect(card(frame)).toBeVisible()
  await expect(cardHost(page)).toHaveCount(0)
  // The frame's card fits inside the frame.
  const box = (await card(frame).boundingBox())!
  const outer = (await page.locator('#frame').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(outer.x)
  expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width)
})
