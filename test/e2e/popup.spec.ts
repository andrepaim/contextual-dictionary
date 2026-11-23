import { expect, test, type Page } from '@playwright/test'
import { ERROR_MESSAGES, formatMegabytes } from '../../src/popup/popup'
import { STORED_NAMES } from '../../src/assets/manifest'
import { card, cardHost, doubleClickWord } from './support/card'
import { install, launch, requestCounts, serviceWorker, status, storedFiles, type Session } from './support/extension'

let session: Session
test.beforeEach(async () => { session = await launch() })
test.afterEach(async () => { await session.close() })

const MODEL_GZ = `${STORED_NAMES.model}.gz`
const section = (popup: Page, bundle: string) => popup.locator(`[data-bundle="${bundle}"]`)
const stateOf = (popup: Page, bundle: string) => section(popup, bundle).locator('[data-part="state"]')

test('each download states its exact size before anything is fetched', async () => {
  const popup = session.control
  await expect(stateOf(popup, 'dictionary')).toHaveText(`Needs a one-time download of ${formatMegabytes(session.fixture.bytes('dictionary'))}.`)
  await expect(stateOf(popup, 'model')).toHaveText(`Needs a one-time download of ${formatMegabytes(session.fixture.bytes('model'))}.`)
  await expect(section(popup, 'model').locator('[data-action="download"]')).toHaveAttribute('aria-label', 'Download the model, 1.5 MB')
  expect(session.server.requests).toEqual([])
})

test('a download shows progress and can be cancelled, leaving nothing behind', async () => {
  const popup = session.control
  session.server.behave(MODEL_GZ, 'hold')
  await section(popup, 'model').locator('[data-action="download"]').click()
  await expect(stateOf(popup, 'model')).toHaveText(/^Downloading [\d.]+ of 1\.5 MB…$/)
  const bar = section(popup, 'model').getByRole('progressbar')
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(20)
  await section(popup, 'model').locator('[data-action="cancel"]').click()
  await expect(stateOf(popup, 'model')).toHaveText('Needs a one-time download of 1.5 MB.')
  // A cancel is not a failure: no error, and the download is offered again.
  await expect(section(popup, 'model').locator('[data-part="error"]')).toHaveCount(0)
  await expect(section(popup, 'model').locator('[data-action="download"]')).toBeVisible()
  // No partial or temporary file is left in the private storage.
  await expect.poll(() => storedFiles(session)).toEqual([])
})

test('a dropped connection shows its message, and Retry finishes the download', async () => {
  const popup = session.control
  session.server.behave(MODEL_GZ, 'drop')
  await section(popup, 'model').locator('[data-action="download"]').click()
  await expect(section(popup, 'model').locator('[data-part="error"]')).toHaveText(ERROR_MESSAGES.DOWNLOAD_FAILED!)
  session.server.behave(MODEL_GZ, 'ok')
  await section(popup, 'model').locator('[data-action="retry"]').click()
  await expect(stateOf(popup, 'model')).toHaveText(/^Installed, [\d.]+ MB used$/)
})

test('altered bytes are refused with their message', async () => {
  const popup = session.control
  session.server.behave(MODEL_GZ, 'wrong')
  await section(popup, 'model').locator('[data-action="download"]').click()
  await expect(section(popup, 'model').locator('[data-part="error"]')).toHaveText(ERROR_MESSAGES.ASSET_CORRUPT!)
  await expect(section(popup, 'model').locator('[data-action="retry"]')).toHaveAttribute('aria-label', 'Retry the model download, 1.5 MB')
  expect((await storedFiles(session)).map(file => file.name)).not.toContain(STORED_NAMES.model)
})

test('an installed bundle shows the storage it uses, and Remove asks before removing', async () => {
  const popup = session.control
  await install(session, 'model')
  await popup.reload()
  const stored = session.fixture.files.model.reduce((sum, file) => sum + file.storedSize, 0)
  await expect(stateOf(popup, 'model')).toHaveText(`Installed, ${formatMegabytes(stored)} used`)
  await section(popup, 'model').locator('[data-action="remove"]').click()
  await expect(section(popup, 'model').locator('[data-part="confirm-remove"]')).toContainText(`This frees ${formatMegabytes(stored)}`)
  await section(popup, 'model').locator('[data-action="keep"]').click()
  expect((await status(popup)).bundles.model.phase).toBe('ready')
  await section(popup, 'model').locator('[data-action="remove"]').click()
  await section(popup, 'model').locator('[data-action="confirm-remove"]').click()
  await expect(stateOf(popup, 'model')).toHaveText('Needs a one-time download of 1.5 MB.')
  expect(await storedFiles(session)).toEqual([])
})

test('turning on ordering without the model asks for consent and never downloads silently', async () => {
  const popup = session.control
  await popup.locator('[data-control="orderByContext"]').click()
  const consent = popup.locator('[data-part="consent"]')
  await expect(consent).toContainText('It needs a one-time download of 1.5 MB.')
  await popup.locator('[data-action="decline-order"]').click()
  await expect(consent).toHaveCount(0)
  await expect(popup.locator('[data-control="orderByContext"]')).not.toBeChecked()
  expect(session.server.requests).toEqual([])
  expect((await status(popup)).settings.orderByContext).toBe(false)

  await popup.locator('[data-control="orderByContext"]').click()
  await popup.locator('[data-action="confirm-order"]').click()
  await expect(stateOf(popup, 'model')).toHaveText(/^Installed/)
  await expect(popup.locator('[data-control="orderByContext"]')).toBeChecked()
  expect(session.server.requests).toEqual(session.fixture.files.model.map(file => file.name))
  await expect.poll(async () => (await status(popup)).ranker.state).toBe('ready')
})

test('the real popup finds the tab host through the page and its site switch silences the page at once', async () => {
  await install(session, 'dictionary')
  // localhost is outside the end-to-end host permission, so the popup cannot read the tab address
  // and asks the page's content script instead.
  const page = await session.context.newPage()
  await page.goto(`${session.localhost}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
  await page.mouse.click(2, 2)

  await page.bringToFront()
  const worker = await serviceWorker(session)
  expect(await worker.evaluate(() => chrome.action.openPopup().then(() => 'opened'))).toBe('opened')
  const popupText = () => session.control.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.body.innerText ?? '')
  await expect.poll(popupText).toContain('On localhost')
  await session.control.evaluate(() => {
    const view = chrome.extension.getViews({ type: 'popup' })[0]!
    view.document.querySelector<HTMLInputElement>('[data-control="site"]')!.click()
  })
  await expect.poll(async () => (await status(session.control)).settings.disabledSites).toEqual(['localhost'])

  const before = (await requestCounts(session)).define
  await doubleClickWord(page.locator('#bank'), 'bank')
  await page.waitForTimeout(600)
  await expect(cardHost(page)).toBeHidden()
  expect((await requestCounts(session)).define).toBe(before)
})
