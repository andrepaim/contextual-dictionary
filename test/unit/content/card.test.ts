// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Card, MEANINGS_SHOWN, placeCard } from '../../../src/content/card'
import type { DictionaryResult } from '../../../src/shared/contracts'

const SOURCE = { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/mouse' }
const anchor = () => ({ top: 100, bottom: 120, left: 200, right: 240 })

function result(overrides: Partial<DictionaryResult> = {}): DictionaryResult {
  return {
    query: 'mouse',
    entries: [
      {
        lemma: 'mouse', partOfSpeech: 'noun', senses: [
          { definition: 'A small rodent.', examples: ['The mouse ate the cheese.', 'A field mouse.'] },
          { definition: 'A pointing device.', examples: [] },
          { definition: 'A shy person.', examples: [] },
          { definition: 'A black eye.', examples: ['He got a mouse in the fight.'] },
          { definition: 'A knot on a rope.', examples: [] },
        ],
      },
      { lemma: 'mouse', partOfSpeech: 'verb', note: 'also spelt mouze', senses: [{ definition: 'To hunt mice.', examples: [] }] },
    ],
    source: SOURCE,
    ...overrides,
  }
}

let cards: Card[] = []
function makeCard(onDismiss = vi.fn()) {
  const card = new Card({ document, onDismiss })
  cards.push(card)
  return { card, onDismiss }
}
const shadow = (card: Card) => card.host!.shadowRoot!
const texts = (card: Card, selector: string) => [...shadow(card).querySelectorAll(selector)].map(node => node.textContent)

afterEach(() => {
  for (const card of cards) card.destroy()
  cards = []
  document.body.innerHTML = ''
})

describe('placeCard', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 340, height: 200 }

  test('goes below the selection, aligned with its left edge', () => {
    expect(placeCard({ top: 100, bottom: 120, left: 200, right: 240 }, size, viewport)).toEqual({ left: 200, top: 128, maxHeight: 664, placement: 'below' })
  })

  test('goes above when there is no room below', () => {
    expect(placeCard({ top: 700, bottom: 720, left: 200, right: 240 }, size, viewport)).toMatchObject({ top: 492, placement: 'above' })
  })

  test('stays inside the viewport horizontally', () => {
    expect(placeCard({ top: 100, bottom: 120, left: 900, right: 950 }, size, viewport).left).toBe(652)
    expect(placeCard({ top: 100, bottom: 120, left: -30, right: 10 }, size, viewport).left).toBe(8)
  })

  test('takes the larger side and limits the height when neither side has room', () => {
    const tall = { width: 340, height: 700 }
    expect(placeCard({ top: 300, bottom: 320, left: 10, right: 20 }, tall, viewport)).toEqual({ left: 10, top: 328, maxHeight: 464, placement: 'below' })
    expect(placeCard({ top: 500, bottom: 520, left: 10, right: 20 }, tall, viewport)).toEqual({ left: 10, top: 8, maxHeight: 484, placement: 'above' })
  })

  test('a viewport narrower than the card puts it at the margin', () => {
    expect(placeCard({ top: 10, bottom: 20, left: 100, right: 120 }, size, { width: 300, height: 800 }).left).toBe(8)
  })
})

describe('Card', () => {
  test('creates nothing until it is first shown', () => {
    const { card } = makeCard()
    expect(card.host).toBeNull()
    expect(card.state).toBe('hidden')
    expect(document.documentElement.children.length).toBe(2)
  })

  test('the placeholder appears at once in a shadow root on one host element', () => {
    const { card } = makeCard()
    card.showPlaceholder(anchor, 'mouse')
    expect(card.state).toBe('placeholder')
    expect(card.host!.parentNode).toBe(document.documentElement)
    const placeholder = shadow(card).querySelector('[data-part="placeholder"]')!
    expect(placeholder.getAttribute('role')).toBe('status')
    expect(placeholder.getAttribute('aria-label')).toBe('Looking up “mouse”')
    card.showPlaceholder(anchor, 'cursor')
    expect(document.querySelectorAll(card.host!.localName).length).toBe(1)
  })

  test('the host is out of the page flow and above page content', () => {
    const { card } = makeCard()
    card.showPlaceholder(anchor, 'mouse')
    const style = card.host!.style
    expect(style.getPropertyValue('position')).toBe('fixed')
    expect(style.getPropertyPriority('position')).toBe('important')
    expect(style.getPropertyValue('z-index')).toBe('2147483647')
    expect(style.getPropertyValue('left')).toBe('200px')
    expect(style.getPropertyValue('top')).toBe('128px')
  })

  test('shows headwords, parts of speech, notes, numbered meanings in order and lighter examples', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    expect(card.state).toBe('card')
    const dialog = shadow(card).querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Definitions of “mouse”')
    expect(texts(card, '[data-part="lemma"]')).toEqual(['mouse', 'mouse'])
    expect(texts(card, '[data-part="pos"]')).toEqual(['noun', 'verb'])
    expect(texts(card, '[data-part="note"]')).toEqual(['also spelt mouze'])
    const lists = shadow(card).querySelectorAll('ol')
    expect(lists.length).toBe(2)
    expect([...lists[0]!.querySelectorAll('[data-part="definition"]')].map(node => node.textContent)).toEqual(['A small rodent.', 'A pointing device.', 'A shy person.'])
    expect(texts(card, '[data-part="example"]')).toEqual(['“The mouse ate the cheese.”', '“A field mouse.”'])
  })

  test('"Show all meanings" reveals the rest and "Show fewer" hides them again', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const toggle = () => shadow(card).querySelector<HTMLButtonElement>('[data-part="toggle"]')!
    expect(MEANINGS_SHOWN).toBe(3)
    expect(toggle().textContent).toBe('Show all meanings')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    toggle().click()
    expect(texts(card, 'ol:first-of-type [data-part="definition"]')).toEqual(['A small rodent.', 'A pointing device.', 'A shy person.', 'A black eye.', 'A knot on a rope.'])
    expect(toggle().textContent).toBe('Show fewer')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    toggle().click()
    expect(texts(card, '[data-part="definition"]')).toHaveLength(4)
    expect(toggle().textContent).toBe('Show all meanings')
  })

  test('no toggle when every entry fits', () => {
    const { card } = makeCard()
    card.showResult(result({ entries: [result().entries[1]!] }), anchor)
    expect(shadow(card).querySelector('[data-part="toggle"]')).toBeNull()
  })

  test('the attribution links to the entry in a new tab without an opener', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const link = shadow(card).querySelector<HTMLAnchorElement>('[data-part="attribution"]')!
    expect(link.textContent).toBe('Wiktionary · CC BY-SA 4.0')
    expect(link.getAttribute('href')).toBe('https://en.wiktionary.org/wiki/mouse')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  test('the attribution is plain text when the source address is not http(s)', () => {
    const { card } = makeCard()
    card.showResult(result({ source: { ...SOURCE, url: 'javascript:alert(1)' } }), anchor)
    const attribution = shadow(card).querySelector('[data-part="attribution"]')!
    expect(attribution.tagName).toBe('SPAN')
    expect(attribution.hasAttribute('href')).toBe(false)
  })

  test('dictionary text is never parsed as HTML', () => {
    const { card } = makeCard()
    const evil = '<img src=x onerror="window.__pwned=1">'
    card.showResult({
      query: evil,
      entries: [{ lemma: evil, partOfSpeech: `<b>noun</b>`, note: evil, senses: [{ definition: evil, examples: [evil] }] }],
      source: SOURCE,
    }, anchor)
    expect(shadow(card).querySelector('img')).toBeNull()
    expect(shadow(card).querySelector('b')).toBeNull()
    expect(texts(card, '[data-part="definition"]')).toEqual([evil])
    expect(shadow(card).querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe(`Definitions of “${evil}”`)
  })

  test('an empty result shows no card', () => {
    const { card } = makeCard()
    card.showPlaceholder(anchor, 'zzz')
    card.showResult(result({ entries: [] }), anchor)
    expect(card.state).toBe('hidden')
    expect(card.host!.style.getPropertyValue('display')).toBe('none')
  })

  test('Escape dismisses it', () => {
    const { card, onDismiss } = makeCard()
    card.showResult(result(), anchor)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card.state).toBe('hidden')
    expect(onDismiss).toHaveBeenCalledWith('escape')
  })

  test('other keys do not dismiss it', () => {
    const { card, onDismiss } = makeCard()
    card.showResult(result(), anchor)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(card.state).toBe('card')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('a click outside dismisses it, a click inside does not and keeps the page selection', () => {
    document.body.innerHTML = '<p id="page">page text</p>'
    const { card, onDismiss } = makeCard()
    card.showResult(result(), anchor)
    const inside = new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true })
    shadow(card).querySelector('[data-part="definition"]')!.dispatchEvent(inside)
    expect(inside.defaultPrevented).toBe(true)
    expect(card.state).toBe('card')
    document.getElementById('page')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
    expect(card.state).toBe('hidden')
    expect(onDismiss).toHaveBeenCalledWith('outside')
  })

  test('a dismissed card stops listening', () => {
    const { card, onDismiss } = makeCard()
    card.showResult(result(), anchor)
    card.hide()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  test('contains tells events from inside the card apart', () => {
    const { card } = makeCard()
    expect(card.contains(document.body)).toBe(false)
    card.showResult(result(), anchor)
    expect(card.contains(card.host)).toBe(true)
    expect(card.contains(document.body)).toBe(false)
    expect(card.contains(null)).toBe(false)
  })

  test('styles live in the shadow root and theme by colour scheme', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const css = shadow(card).querySelector('style')!.textContent!
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain('max-height')
    expect(css).toContain('overflow-y: auto')
    expect(document.head.querySelector('style')).toBeNull()
  })

  test('follows its word when the page scrolls', async () => {
    const { card } = makeCard()
    let top = 100
    card.showResult(result(), () => ({ top, bottom: top + 20, left: 200, right: 240 }))
    top = 50
    document.dispatchEvent(new Event('scroll'))
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    expect(card.host!.style.getPropertyValue('top')).toBe('78px')
  })

  test('without an anchor it keeps its last position', () => {
    const { card } = makeCard()
    card.showPlaceholder(() => null, 'mouse')
    expect(card.host!.style.getPropertyValue('left')).toBe('8px')
  })

  test('destroy removes the host', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const host = card.host!
    card.destroy()
    expect(host.isConnected).toBe(false)
    expect(card.state).toBe('hidden')
  })
})
