import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { expected, type exerciseCore } from '../fixtures/core'

test('uses the same shared dictionary pack and model order in Chromium', async ({ page }) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../fixtures/core.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'coreFixture',
  })
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
  const result = await page.evaluate(() => {
    const { coreFixture } = window as Window & { coreFixture?: { exerciseCore: typeof exerciseCore } }
    return coreFixture!.exerciseCore()
  })
  expect(result).toEqual(expected)
})
