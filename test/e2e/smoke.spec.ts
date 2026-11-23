import { expect, test } from '@playwright/test'
import { launchExtension, serveFixtures } from './helpers'

test('the built extension loads and its content script runs on an ordinary page', async () => {
  const { context, worker, extensionId } = await launchExtension()
  const fixtures = await serveFixtures()
  try {
    expect(worker.url()).toBe(`chrome-extension://${extensionId}/service-worker.js`)
    const page = await context.newPage()
    await page.goto(`${fixtures.url}/article.html`)
    await expect(page.locator('html')).toHaveAttribute('data-contextual-dictionary', 'loaded')
  } finally {
    await context.close()
    await fixtures.close()
  }
})

test('the popup page opens', async () => {
  const { context, extensionId } = await launchExtension()
  try {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`)
    await expect(page).toHaveTitle('Contextual Dictionary')
  } finally {
    await context.close()
  }
})
