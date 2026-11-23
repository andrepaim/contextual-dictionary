import { expect, test, type Page } from '@playwright/test'
import { card, cardHost, doubleClickWord, placeholder, shownEntries, gotoReady } from './support/card'
import { MOUSE_DICTIONARY_ORDER } from './support/assets'
import { install, launch, requestCounts, type Session } from './support/extension'

let session: Session
test.beforeEach(async () => {
  session = await launch()
  await install(session, 'dictionary')
})
test.afterEach(async () => { await session.close() })

/** Records each thing the card shows, from its first appearance on. */
async function recordCard(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = []
    Object.assign(window, { cardStates: seen })
    const watch = (host: Element) => {
      const content = host.shadowRoot!.lastElementChild!
      const note = () => { const part = (content.firstElementChild as HTMLElement | null)?.dataset.part; if (part) seen.push(part) }
      note()
      new MutationObserver(note).observe(content, { childList: true })
    }
    new MutationObserver((records, observer) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.localName === 'contextual-dictionary-card') { observer.disconnect(); watch(node) }
      }
    }).observe(document.documentElement, { childList: true })
  })
  return () => page.evaluate(() => (window as unknown as { cardStates: string[] }).cardStates)
}

test('double-clicking a word shows a placeholder, then one card with its entries and attribution', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const states = await recordCard(page)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  expect(await shownEntries(page)).toEqual([
    { lemma: 'mouse', pos: 'noun', note: null, definitions: MOUSE_DICTIONARY_ORDER },
    { lemma: 'mouse', pos: 'verb', note: null, definitions: ['To hunt for mice.', 'To move cautiously, like a mouse.'] },
  ])
  await expect(card(page).locator('[data-part="example"]')).toHaveText(['“He was a mouse at parties.”'])
  const attribution = card(page).locator('[data-part="attribution"]')
  await expect(attribution).toHaveText('Wiktionary · CC BY-SA 4.0')
  await expect(attribution).toHaveAttribute('href', 'https://en.wiktionary.org/wiki/mouse')
  expect(await states()).toEqual(['placeholder', 'card'])
  await expect(card(page)).toHaveAttribute('aria-label', 'Definitions of “mouse”')
  expect((await requestCounts(session)).define).toBe(1)
})

test('an inflection shows the base word with a note', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await page.evaluate(() => { document.querySelector('#mouse')!.textContent = 'Three blind mice ran across the kitchen floor.' })
  await doubleClickWord(page.locator('#mouse'), 'mice')
  const [first] = await shownEntries(page)
  expect(first).toMatchObject({ lemma: 'mouse', pos: 'noun', note: 'plural of mouse' })
})

test('an unknown word shows no card', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const states = await recordCard(page)
  await doubleClickWord(page.locator('#unknown'), 'qwzxqvplk')
  await expect.poll(async () => (await requestCounts(session)).define).toBe(1)
  await expect.poll(states).toEqual(['placeholder'])
  await expect(cardHost(page)).toBeHidden()
  await expect(card(page)).toHaveCount(0)
})

test('Escape and a click outside dismiss the card', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cardHost(page)).toBeHidden()

  await page.mouse.click(5, 5)
  await doubleClickWord(page.locator('#bank'), 'bank')
  await expect(card(page)).toBeVisible()
  await page.locator('h1').click()
  await expect(cardHost(page)).toBeHidden()
})

test('a click inside the card keeps it open, and "Show all meanings" is not needed for short entries', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  await card(page).locator('[data-part="lemma"]').first().click()
  await expect(card(page)).toBeVisible()
  await expect(card(page).locator('[data-part="toggle"]')).toHaveCount(0)
})

test('without the dictionary a double-click shows nothing and stays quiet', async () => {
  await session.close()
  session = await launch()
  const page = await session.context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await gotoReady(page, `${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect.poll(async () => (await requestCounts(session)).define).toBe(1)
  await expect(cardHost(page)).toBeHidden()
  expect(errors).toEqual([])
})
