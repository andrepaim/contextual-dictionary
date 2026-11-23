import { expect, test } from '@playwright/test'
import { STORED_NAMES } from '../../src/assets/manifest'
import { card, cardHost, doubleClickWord, shownEntries } from './support/card'
import { closeOffscreen, install, launch, requestCounts, status, storedFiles, type Session } from './support/extension'

// The extension's real private file storage (the origin private file system) in Chromium.
let session: Session
test.afterEach(async () => { await session?.close() })

test('a redirected gzip download is unpacked into private storage', async () => {
  session = await launch()
  await install(session, 'model')
  const model = session.fixture.files.model
  // Release URLs answer with a redirect to the storage address, as GitHub does; each is fetched once.
  expect(session.server.requests).toEqual(model.map(file => file.name))
  expect(await storedFiles(session)).toEqual(model.map(file => ({ name: file.storedName, size: file.storedSize })).sort((a, b) => a.name.localeCompare(b.name)))
  expect(model[0]!.encoding).toBe('gzip')
  expect(model[0]!.name).not.toBe(model[0]!.storedName)
})

test('a stored file altered at the same size is detected and offered for download again', async () => {
  session = await launch()
  await install(session, 'dictionary')
  // A new offscreen document is a new session: it hashes each file again on first use.
  await closeOffscreen(session)
  await session.control.evaluate(async name => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('assets')
    const handle = await directory.getFileHandle(name)
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    bytes[bytes.length - 40] ^= 0xff
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
  }, STORED_NAMES.dictionary)
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect.poll(async () => (await requestCounts(session)).define).toBeGreaterThan(0)
  await expect(cardHost(page)).toBeHidden()
  expect((await storedFiles(session)).map(file => file.name)).not.toContain(STORED_NAMES.dictionary)
  await session.control.reload()
  const section = session.control.locator('[data-bundle="dictionary"]')
  await expect(section.locator('[data-part="state"]')).toHaveText(/^Needs a one-time download/)
  await section.locator('[data-action="download"]').click()
  await expect(section.locator('[data-part="state"]')).toHaveText(/^Installed/)
  await page.mouse.click(2, 2)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  await expect(card(page)).toBeVisible()
})

test('installed files and settings persist across a browser restart with the same profile', async () => {
  const first = await launch()
  await install(first, 'dictionary', 'model')
  await first.control.locator('[data-control="orderByContext"]').click()
  await expect.poll(async () => (await status(first.control)).settings.orderByContext).toBe(true)
  await first.close({ keepProfile: true })

  session = await launch({ reuse: first })
  const now = await status(session.control)
  expect(now.bundles.dictionary.phase).toBe('ready')
  expect(now.bundles.model.phase).toBe('ready')
  expect(now.settings.orderByContext).toBe(true)
  const page = await session.context.newPage()
  await page.goto(`${session.pages}/article.html`)
  await doubleClickWord(page.locator('#mouse'), 'mouse')
  expect((await shownEntries(page))[0]!.lemma).toBe('mouse')
  expect(session.server.requests).toEqual([])
})
