import { expect, test, type Page } from '@playwright/test'
import { card, cardHost, doubleClickWord, meanings, gotoReady, shownEntries } from './support/card'
import { MOUSE_CONTEXT_ORDER, MOUSE_DICTIONARY_ORDER } from './support/assets'
import { install, launch, send, status, type Session } from './support/extension'

let session: Session
test.beforeEach(async () => {
  session = await launch()
  await install(session, 'dictionary', 'model')
})
test.afterEach(async () => { await session.close() })

/** Dismisses any card, so the same word can be looked up again. */
async function lookUp(page: Page, selector: string, word: string): Promise<void> {
  await page.mouse.click(2, 2)
  await expect(cardHost(page)).toBeHidden()
  await doubleClickWord(page.locator(selector), word)
  await expect(card(page)).toBeVisible()
}

async function setOrdering(session: Session, on: boolean): Promise<void> {
  await session.control.reload()
  const control = session.control.locator('[data-control="orderByContext"]')
  await expect(control).toBeEnabled()
  if ((await control.isChecked()) !== on) await control.click()
  await expect(control).toBeChecked({ checked: on })
}

test('the order follows the context when "Order by context" is on, and returns when it is off, without a reload', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_DICTIONARY_ORDER)

  await setOrdering(session, true)
  await expect.poll(async () => (await status(session.control)).ranker.state).toBe('ready')
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_CONTEXT_ORDER)
  expect(await meanings(page, 'mouse', 'verb')).toEqual(['To move cautiously, like a mouse.', 'To hunt for mice.'])

  await setOrdering(session, false)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_DICTIONARY_ORDER)
  expect((await status(session.control)).ranker.state).toBe('idle')
})

test('the entry holding the best meaning comes first when "Order by context" is on, and the entries keep dictionary order when it is off', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  const heads = async () => (await shownEntries(page)).map(entry => `${entry.lemma} ${entry.pos}`)
  await lookUp(page, '#pilot', 'bank')
  expect(await heads()).toEqual(['bank noun', 'bank verb'])

  await setOrdering(session, true)
  await expect.poll(async () => (await status(session.control)).ranker.state).toBe('ready')
  await lookUp(page, '#pilot', 'bank')
  // The fake model puts the aircraft meaning of the verb first, far above every meaning of the noun.
  expect(await heads()).toEqual(['bank verb', 'bank noun'])
  expect(await meanings(page, 'bank', 'verb')).toEqual(['To tilt an aircraft to one side when turning.', 'To put money in a bank.'])
  // Where no other entry beats it, the first entry stays first.
  await lookUp(page, '#bank', 'bank')
  expect(await heads()).toEqual(['bank noun', 'bank verb'])

  await setOrdering(session, false)
  await lookUp(page, '#pilot', 'bank')
  expect(await heads()).toEqual(['bank noun', 'bank verb'])
  expect(await meanings(page, 'bank', 'verb')).toEqual(['To put money in a bank.', 'To tilt an aircraft to one side when turning.'])
})

test('a model answer later than the budget leaves dictionary order, and orders the next lookup of the same passage', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await setOrdering(session, true)
  await expect.poll(async () => (await status(session.control)).ranker.state).toBe('ready')
  const dictionary = ['A single sheet of paper in a book.', 'The flat green part of a plant that grows from a stem.']

  const started = Date.now()
  await lookUp(page, '#slow', 'leaf')
  // The card appeared at the budget (350 ms), not when the fake model answered (1.5 s).
  expect(Date.now() - started).toBeLessThan(1400)
  expect(await meanings(page, 'leaf', 'noun')).toEqual(dictionary)
  await page.waitForTimeout(1600)
  await lookUp(page, '#slow', 'leaf')
  expect(await meanings(page, 'leaf', 'noun')).toEqual([...dictionary].reverse())
})

test('the budget setting applies at once', async () => {
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await setOrdering(session, true)
  await expect.poll(async () => (await status(session.control)).ranker.state).toBe('ready')
  const reply = await send(session.control, { type: 'set-settings', patch: { budgetMs: 2000 } })
  expect(reply.ok).toBe(true)
  // With a 2 s budget the slow answer (1.5 s) arrives in time.
  await lookUp(page, '#slow', 'leaf')
  expect(await meanings(page, 'leaf', 'noun')).toEqual(['The flat green part of a plant that grows from a stem.', 'A single sheet of paper in a book.'])
})
