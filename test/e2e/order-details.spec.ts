import { expect, test, type Page } from '@playwright/test'
import { card, cardHost, doubleClickWord, gotoReady, meanings } from './support/card'
import { MOUSE_CONTEXT_ORDER, MOUSE_DICTIONARY_ORDER } from './support/assets'
import { install, launch, send, status, type Session } from './support/extension'

// "Show order details" (docs/order-details-plan.md), with the fake model of the
// end-to-end build: it puts the pointing device first for the fixture article.
let session: Session | undefined
test.afterEach(async () => { await session?.close(); session = undefined })

const DETAIL_PARTS = ['was', 'unranked', 'order-status', 'entry-was']

/** Dismisses any card, so the same word can be looked up again. */
async function lookUp(page: Page, selector: string, word: string): Promise<void> {
  await page.mouse.click(2, 2)
  await expect(cardHost(page)).toBeHidden()
  await doubleClickWord(page.locator(selector), word)
  await expect(card(page)).toBeVisible()
}

/** Sets a switch in the extension's window, as a reader does. */
async function setSwitch(session: Session, name: string, on: boolean): Promise<void> {
  await session.control.reload()
  const control = session.control.locator(`[data-control="${name}"]`)
  await expect(control).toBeEnabled()
  if ((await control.isChecked()) !== on) await control.click()
  await expect(control).toBeChecked({ checked: on })
  await expect.poll(async () => (await status(session.control)).settings).toMatchObject({ [name]: on })
}

/** Each meaning of the entry as [definition, "was" tag or null]. */
async function tagged(page: Page, pos: string): Promise<Array<[string, string | null]>> {
  return card(page).locator('section.dc-entry').evaluateAll((sections, pos) => {
    const section = sections.find(node => node.querySelector('[data-part="pos"]')!.textContent === pos)!
    return [...section.querySelectorAll('li:not([data-part="unranked"])')]
      .map(item => [item.querySelector('[data-part="definition"]')!.textContent!, item.querySelector('[data-part="was"]')?.textContent ?? null] as [string, string | null])
  }, pos)
}

async function orderedSession(): Promise<Session> {
  const started = await launch()
  await install(started, 'dictionary', 'model')
  await setSwitch(started, 'orderByContext', true)
  await expect.poll(async () => (await status(started.control)).ranker.state).toBe('ready')
  return started
}

test('the switch sits below "Order by context" and is off by default', async () => {
  session = await launch({ defaults: true })
  await expect(session.control.locator('[data-control="site"]')).toBeVisible()
  const names = await session.control.locator('[data-control]').evaluateAll(inputs => inputs.map(input => (input as HTMLElement).dataset.control))
  expect(names.slice(0, 3)).toEqual(['definitions', 'orderByContext', 'showOrderDetails'])
  await expect(session.control.locator('[data-control="showOrderDetails"]')).not.toBeChecked()
  await expect(session.control.locator('label', { has: session.control.locator('[data-control="showOrderDetails"]') })).toHaveText('Show order details')
  expect((await status(session.control)).settings.showOrderDetails).toBe(false)
})

test('switch on: a reordered card shows where each moved meaning was, and "Ordered by context"', async () => {
  session = await orderedSession()
  await setSwitch(session, 'showOrderDetails', true)
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_CONTEXT_ORDER)
  expect(await tagged(page, 'noun')).toEqual([[MOUSE_DICTIONARY_ORDER[2], 'was 3rd'], [MOUSE_DICTIONARY_ORDER[0], 'was 1st'], [MOUSE_DICTIONARY_ORDER[1], 'was 2nd']])
  expect(await tagged(page, 'verb')).toEqual([['To move cautiously, like a mouse.', 'was 2nd'], ['To hunt for mice.', 'was 1st']])
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Ordered by context')
  // Every meaning was offered to the model.
  await expect(card(page).locator('[data-part="unranked"]')).toHaveCount(0)
  // No score, percentage or timing anywhere in the card's own words.
  for (const part of ['was', 'order-status']) for (const text of await card(page).locator(`[data-part="${part}"]`).allTextContents()) expect(text).not.toMatch(/%|\bms\b|\d+\.\d|second/)
})

test('switch on: an entry moved first says where it was among the entries; switch off: nothing', async () => {
  session = await orderedSession()
  await setSwitch(session, 'showOrderDetails', true)
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#pilot', 'bank')
  const heads = card(page).locator('section.dc-entry .dc-head')
  await expect(heads.first().locator('[data-part="pos"]')).toHaveText('verb')
  await expect(heads.first().locator('[data-part="entry-was"]')).toHaveText('was 2nd entry')
  await expect(card(page).locator('[data-part="entry-was"]')).toHaveCount(1)
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Ordered by context')

  await setSwitch(session, 'showOrderDetails', false)
  await lookUp(page, '#pilot', 'bank')
  await expect(heads.first().locator('[data-part="pos"]')).toHaveText('verb')
  for (const part of DETAIL_PARTS) await expect(card(page).locator(`[data-part="${part}"]`), part).toHaveCount(0)
})

test('switch off: the reordered card has none of the details', async () => {
  session = await orderedSession()
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_CONTEXT_ORDER)
  for (const part of DETAIL_PARTS) await expect(card(page).locator(`[data-part="${part}"]`), part).toHaveCount(0)

  // Turned on and off again, it applies to the next lookup without a reload.
  await setSwitch(session, 'showOrderDetails', true)
  await lookUp(page, '#mouse', 'mouse')
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Ordered by context')
  await setSwitch(session, 'showOrderDetails', false)
  await lookUp(page, '#mouse', 'mouse')
  for (const part of DETAIL_PARTS) await expect(card(page).locator(`[data-part="${part}"]`), part).toHaveCount(0)
})

test('switch on with "Order by context" off: dictionary order, and the card says ordering is off', async () => {
  session = await launch()
  await install(session, 'dictionary', 'model')
  await setSwitch(session, 'showOrderDetails', true)
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_DICTIONARY_ORDER)
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Dictionary order · ordering is off')
  await expect(card(page).locator('[data-part="was"]')).toHaveCount(0)
})

test('switch on without the model: the card says the context model is not installed', async () => {
  session = await launch()
  await install(session, 'dictionary')
  expect((await send(session.control, { type: 'set-settings', patch: { orderByContext: true, showOrderDetails: true } })).ok).toBe(true)
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  expect(await meanings(page, 'mouse', 'noun')).toEqual(MOUSE_DICTIONARY_ORDER)
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Dictionary order · context model not installed')
})

test('the setting survives a browser restart', async () => {
  const first = await launch()
  await install(first, 'dictionary')
  await setSwitch(first, 'showOrderDetails', true)
  await first.close({ keepProfile: true })

  session = await launch({ reuse: first })
  expect((await status(session.control)).settings.showOrderDetails).toBe(true)
  await expect(session.control.locator('[data-control="showOrderDetails"]')).toBeChecked()
  const page = await session.context.newPage()
  await gotoReady(page, `${session.pages}/article.html`)
  await lookUp(page, '#mouse', 'mouse')
  await expect(card(page).locator('[data-part="order-status"]')).toHaveText('Dictionary order · ordering is off')
})
