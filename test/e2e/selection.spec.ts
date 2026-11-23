import { expect, test } from '@playwright/test'
import { card, cardHost, doubleClickWord, shownEntries, wordBox, gotoReady } from './support/card'
import { install, launch, requestCounts, type Session } from './support/extension'

let session: Session
test.beforeAll(async () => {
  // Caret browsing (F7) is how readers select page text with the keyboard.
  session = await launch({ args: ['--enable-caret-browsing'] })
  await install(session, 'dictionary')
})
test.afterAll(async () => { await session.close() })

const defines = async () => (await requestCounts(session)).define ?? 0

test('a real double-click sends one lookup', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const before = await defines()
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  await page.waitForTimeout(500)
  expect(await defines()).toBe(before + 1)
  await page.close()
})

test('a selection made with the keyboard is looked up', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await page.evaluate(() => {
    const text = document.querySelector('#bank')!.firstChild!
    getSelection()!.collapse(text, text.textContent!.indexOf('bank'))
  })
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(card(page)).toBeVisible()
  expect((await shownEntries(page))[0]).toMatchObject({ lemma: 'bank', pos: 'noun' })
  await page.close()
})

test('a selection across inline elements finds the compound', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const paragraph = page.locator('#split')
  const origin = (await paragraph.boundingBox())!
  const start = await wordBox(paragraph, 'neural')
  const end = await wordBox(page.locator('#split span'), 'network')
  const span = (await page.locator('#split span').boundingBox())!
  await page.mouse.move(origin.x + start.x + 1, origin.y + start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(span.x + end.x + end.width - 1, span.y + end.y + end.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(card(page)).toBeVisible()
  expect(await shownEntries(page)).toEqual([expect.objectContaining({ lemma: 'neural network', pos: 'noun' })])
  await page.close()
})

test('text in inputs, textareas and editable elements is ignored', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const before = await defines()
  await page.locator('#field').dblclick({ position: { x: 20, y: 8 } })
  await page.locator('#area').dblclick({ position: { x: 20, y: 8 } })
  await doubleClickWord(page.locator('#editable'), 'mouse')
  await page.waitForTimeout(800)
  expect(await defines()).toBe(before)
  await expect(cardHost(page)).toHaveCount(0)
  await page.close()
})

test('a word inside an open shadow root is looked up', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await doubleClickWord(page.locator('#inside'), 'mouse')
  await expect(card(page)).toBeVisible()
  expect((await shownEntries(page))[0]).toMatchObject({ lemma: 'mouse', pos: 'noun' })
  await page.close()
})

test('near the bottom right corner the card stays inside the viewport, above the word', async () => {
  const page = await session.context.newPage()
  await page.setViewportSize({ width: 800, height: 600 })
  await gotoReady(page, `${session.pages}/corner.html`)
  const corner = page.locator('#corner')
  const word = await wordBox(corner, 'mouse')
  const origin = (await corner.boundingBox())!
  await doubleClickWord(corner, 'mouse')
  await expect(card(page)).toBeVisible()
  const box = (await card(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(800)
  expect(box.y + box.height).toBeLessThanOrEqual(origin.y + word.y)
  await page.close()
})

test('the card follows a dark colour scheme', async () => {
  const page = await session.context.newPage()
  await page.emulateMedia({ colorScheme: 'dark' })
  await gotoReady(page, `${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toHaveCSS('background-color', 'rgb(34, 39, 46)')
  await expect(card(page).locator('[data-part="definition"]').first()).toHaveCSS('color', 'rgb(230, 237, 243)')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(card(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await page.close()
})

test('hostile page styles do not reach the card', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/hostile.html`)
  await doubleClickWord(page.locator('#hostile'), 'mouse')
  await expect(card(page)).toBeVisible()
  const host = cardHost(page)
  await expect(host).toHaveCSS('display', 'block')
  await expect(host).toHaveCSS('opacity', '1')
  await expect(host).toHaveCSS('transform', 'none')
  const definition = card(page).locator('[data-part="definition"]').first()
  await expect(definition).toBeVisible()
  await expect(definition).toHaveCSS('font-size', '14px')
  await expect(definition).toHaveCSS('color', 'rgb(31, 35, 40)')
  await expect(card(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(card(page).locator('li')).toHaveCount(5)
  // And the card's own styles do not leak out.
  await expect(page.locator('#hostile')).toHaveCSS('font-size', '40px')
  await page.close()
})
