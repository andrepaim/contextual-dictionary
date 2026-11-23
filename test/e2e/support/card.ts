// Reading and driving the definition card on a fixture page.
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test'

type Scope = Page | FrameLocator

export const cardHost = (scope: Scope) => scope.locator('contextual-dictionary-card')
export const card = (scope: Scope) => scope.locator('contextual-dictionary-card [data-part="card"]')
export const placeholder = (scope: Scope) => scope.locator('contextual-dictionary-card [data-part="placeholder"]')

export interface ShownEntry { lemma: string; pos: string; note: string | null; definitions: string[] }

/** The entries the card shows, in order. */
export async function shownEntries(scope: Scope): Promise<ShownEntry[]> {
  await expect(card(scope)).toBeVisible()
  return card(scope).locator('section.entry').evaluateAll(sections => sections.map(section => ({
    lemma: section.querySelector('[data-part="lemma"]')!.textContent!,
    pos: section.querySelector('[data-part="pos"]')!.textContent!,
    note: section.querySelector('[data-part="note"]')?.textContent ?? null,
    definitions: [...section.querySelectorAll('[data-part="definition"]')].map(node => node.textContent!),
  })))
}

/** The meanings of the first entry with this lemma and part of speech. */
export async function meanings(scope: Scope, lemma: string, pos: string): Promise<string[]> {
  return (await shownEntries(scope)).find(entry => entry.lemma === lemma && entry.pos === pos)?.definitions ?? []
}

/** Where `word` is inside `element`, relative to the element's top-left corner. */
export async function wordBox(element: Locator, word: string): Promise<{ x: number; y: number; width: number; height: number }> {
  return element.evaluate((node, word) => {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const at = text.textContent!.indexOf(word)
      if (at < 0) continue
      const range = node.ownerDocument.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + word.length)
      const box = range.getBoundingClientRect(), origin = (node as Element).getBoundingClientRect()
      return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height }
    }
    throw new Error(`"${word}" not found`)
  }, word)
}

/** A real double-click on `word` inside `element`, as a reader makes it. */
export async function doubleClickWord(element: Locator, word: string): Promise<void> {
  const box = await wordBox(element, word)
  await element.dblclick({ position: { x: box.x + box.width / 2, y: box.y + box.height / 2 } })
}
