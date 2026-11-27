// @vitest-environment happy-dom
import { cardFixture } from '@andrepaim/contextual-dictionary-core/card-fixture'
import cardCss from '@andrepaim/contextual-dictionary-core/card.css?inline'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Card, placeCard } from '../../../src/content/card'
import type { DictionaryResult, OrderDetails } from '../../../src/shared/contracts'

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
    expect(texts(card, '[data-part="example"]')).toEqual(['“The mouse ate the cheese.”'])
  })

  test('"Show all meanings" reveals the rest and "Show fewer" hides them again', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const toggle = () => shadow(card).querySelector<HTMLButtonElement>('[data-part="toggle"]')!
    expect(toggle().textContent).toBe('Show all meanings')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    toggle().click()
    expect(texts(card, 'section:first-of-type [data-part="definition"]')).toEqual(['A small rodent.', 'A pointing device.', 'A shy person.', 'A black eye.', 'A knot on a rope.'])
    expect(texts(card, '[data-part="example"]')).toEqual(['“The mouse ate the cheese.”', '“A field mouse.”', '“He got a mouse in the fight.”'])
    expect(toggle().textContent).toBe('Show fewer')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    toggle().click()
    expect(texts(card, '[data-part="definition"]')).toHaveLength(4)
    expect(toggle().textContent).toBe('Show all meanings')
  })

  test('renders the shared fixture with every preview cap and exposes all content on expansion', () => {
    const { card } = makeCard()
    card.showResult(cardFixture, anchor)
    const renderedEntries = () => [...shadow(card).querySelectorAll('.dc-entry')].map(section => ({
      lemma: section.querySelector('.dc-lemma')?.textContent,
      partOfSpeech: section.querySelector('.dc-pos')?.textContent,
      note: section.querySelector('.dc-note')?.textContent,
      senses: [...section.querySelectorAll('.dc-senses li')].map(item => ({
        definition: item.querySelector('.dc-definition')?.textContent,
        examples: [...item.querySelectorAll('.dc-example')].map(example => example.textContent),
      })),
    }))
    const entries = cardFixture.entries.map(entry => ({
      lemma: entry.lemma,
      partOfSpeech: entry.partOfSpeech,
      note: entry.note,
      senses: entry.senses.map(sense => ({ ...sense, examples: sense.examples.map(example => `“${example}”`) })),
    }))
    const preview = entries.slice(0, 3).map(entry => ({
      ...entry,
      senses: entry.senses.slice(0, 3).map(sense => ({ ...sense, examples: sense.examples.slice(0, 1) })),
    }))
    expect(renderedEntries()).toEqual(preview)
    const attribution = shadow(card).querySelector<HTMLAnchorElement>('.dc-attribution')!
    expect(attribution.textContent).toBe(`${cardFixture.source.name} · ${cardFixture.source.license}`)
    expect(attribution.href).toBe(cardFixture.source.url)
    const toggle = shadow(card).querySelector<HTMLButtonElement>('.dc-toggle')!
    expect(toggle.getAttribute('aria-controls')).toBe(shadow(card).querySelector('.dc-body')?.id)
    toggle.click()
    expect(renderedEntries()).toEqual(entries)
    toggle.click()
    expect(renderedEntries()).toEqual(preview)
  })

  test('an additional example alone makes the card expandable', () => {
    const { card } = makeCard()
    const entry = result().entries[0]!
    card.showResult(result({ entries: [{ ...entry, senses: entry.senses.slice(0, 1) }] }), anchor)
    expect(shadow(card).querySelector('[data-part="toggle"]')?.textContent).toBe('Show all meanings')
    expect(texts(card, '[data-part="example"]')).toHaveLength(1)
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
    expect(cardCss).toContain('.dc-card')
    expect(css).toContain(cardCss)
    expect(css).toContain('prefers-color-scheme: dark')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('max-height')
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

describe('Card: order details', () => {
  const cardHtml = (card: Card) => shadow(card).querySelector('[data-part="card"]')!.outerHTML
  const toggle = (card: Card) => shadow(card).querySelector<HTMLButtonElement>('[data-part="toggle"]')!
  const statusLine = (card: Card) => shadow(card).querySelector('[data-part="order-status"]')
  /** Each meaning of entry `e` as its definition and its tag (null without one), with "—" for the divider. */
  const rows = (card: Card, e = 0) => [...shadow(card).querySelectorAll('section.dc-entry')[e]!.querySelector('ol')!.children].map(item =>
    item.getAttribute('data-part') === 'unranked' ? '—' : [item.querySelector('[data-part="definition"]')!.textContent, item.querySelector('[data-part="was"]')?.textContent ?? null])
  // result(): the noun's five meanings and the verb's one. The model was offered all of them.
  const moved: OrderDetails = { status: 'ordered', positions: [[1, 0, 2, 4, 3], [0]], offered: [5, 1] }

  test('without details the card shows no status or order annotations', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    expect(statusLine(card)).toBeNull()
    expect(texts(card, '[data-part="was"], [data-part="unranked"], [data-part="entry-was"]')).toEqual([])
    toggle(card).click()
    expect(statusLine(card)).toBeNull()
    expect(texts(card, '[data-part="was"], [data-part="unranked"], [data-part="entry-was"]')).toEqual([])
  })

  test('malformed details render the same card as an ordinary lookup', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor)
    const plainCard = cardHtml(card)
    for (const details of [
      { status: 'ordered' },
      { status: 'ordered', positions: [[1, 0, 2, 4, 3]], offered: [5, 1] },
      { status: 'ordered', positions: [[1, 1, 2, 4, 3], [0]], offered: [5, 1] },
      { status: 'ordered', positions: [[1, 0, 2, 4, 3], [0]], offered: [6, 1] },
      { status: 'ordered', positions: [[1, 0, 2, 4, 3], [0]], offered: [5, 1], entryPositions: [0, 0] },
      { status: 'ordered', positions: [[1, 0, 2, 4, 3], [0]], offered: [5, 1], entryPositions: [1] },
      { status: 'fine' },
      'ordered',
    ]) {
      card.showResult(result(), anchor, details as unknown as OrderDetails)
      expect(cardHtml(card), JSON.stringify(details)).toBe(plainCard)
    }
  })

  test('a moved meaning carries "was" and its dictionary position; one in its place carries nothing', () => {
    const { card } = makeCard()
    const reordered = result()
    reordered.entries[0]!.senses = moved.positions![0]!.map(position => result().entries[0]!.senses[position]!)
    card.showResult(reordered, anchor, moved)
    expect(rows(card)).toEqual([['A pointing device.', 'was 2nd'], ['A small rodent.', 'was 1st'], ['A shy person.', null]])
    toggle(card).click()
    expect(rows(card)).toEqual([['A pointing device.', 'was 2nd'], ['A small rodent.', 'was 1st'], ['A shy person.', null], ['A knot on a rope.', 'was 5th'], ['A black eye.', 'was 4th']])
    expect(rows(card, 1)).toEqual([['To hunt mice.', null]])
    toggle(card).click()
    expect(rows(card)).toHaveLength(3)
    // The tag follows the definition text, before the examples.
    const second = shadow(card).querySelectorAll('ol')[0]!.children[1]!
    expect([...second.children].map(child => child.getAttribute('data-part'))).toEqual(['definition', 'was', 'example'])
  })

  test('the status line opens the footer', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor, moved)
    const footer = shadow(card).querySelector('.dc-footer')!
    expect(footer.firstElementChild).toBe(statusLine(card))
    expect(statusLine(card)!.textContent).toBe('Ordered by context')
    expect([...footer.children].map(child => child.getAttribute('data-part'))).toEqual(['order-status', 'toggle', 'attribution'])
    card.showResult(result({ entries: [result().entries[1]!] }), anchor, { status: 'nothing-to-order' })
    expect([...shadow(card).querySelector('.dc-footer')!.children].map(child => child.getAttribute('data-part'))).toEqual(['order-status', 'attribution'])
  })

  test('each status has its line, and only "ordered" tags meanings', () => {
    const { card } = makeCard()
    const lines: Array<[OrderDetails, string]> = [
      [moved, 'Ordered by context'],
      [{ status: 'ordered', positions: [[0, 1, 2, 3, 4], [0]], offered: [5, 1] }, 'Ordered by context · same as dictionary order'],
      [{ status: 'off' }, 'Dictionary order · ordering is off'],
      [{ status: 'no-model' }, 'Dictionary order · context model not installed'],
      [{ status: 'loading' }, 'Dictionary order · model still loading'],
      [{ status: 'timed-out' }, 'Dictionary order · model took too long, try again'],
      [{ status: 'nothing-to-order' }, 'Dictionary order · nothing to reorder'],
      [{ status: 'not-english' }, 'Dictionary order · text does not look English'],
      [{ status: 'none-fits' }, 'Dictionary order · the model found no fitting meaning'],
      [{ status: 'unavailable' }, 'Dictionary order · ordering unavailable'],
      // Positions that come with another status are not read.
      [{ status: 'loading', positions: [[1, 0, 2, 4, 3], [0]], offered: [5, 1] }, 'Dictionary order · model still loading'],
    ]
    for (const [details, text] of lines) {
      card.showResult(result(), anchor, details)
      expect(statusLine(card)!.textContent).toBe(text)
      const tags = shadow(card).querySelectorAll('[data-part="was"]').length
      expect(tags > 0, text).toBe(details === moved)
      expect(shadow(card).querySelector('[data-part="unranked"]')).toBeNull()
    }
  })

  test('the divider stands before the meanings the model was not offered, only while they are visible', () => {
    const { card } = makeCard()
    // Offered two meanings of the noun: the shown third one was not offered.
    card.showResult(result(), anchor, { status: 'ordered', positions: [[1, 0, 2, 3, 4], [0]], offered: [2, 1] })
    expect(rows(card)).toEqual([['A small rodent.', 'was 2nd'], ['A pointing device.', 'was 1st'], '—', ['A shy person.', null]])
    expect(shadow(card).querySelector('[data-part="unranked"]')!.textContent).toBe('Not seen by the model')
    expect(shadow(card).querySelectorAll('[data-part="unranked"]')).toHaveLength(1)
    // Offered three: the divider appears with "Show all meanings" and goes with "Show fewer".
    card.showResult(result(), anchor, { status: 'ordered', positions: [[0, 2, 1, 3, 4], [0]], offered: [3, 1] })
    expect(rows(card)).toEqual([['A small rodent.', null], ['A pointing device.', 'was 3rd'], ['A shy person.', 'was 2nd']])
    toggle(card).click()
    expect(rows(card)).toEqual([['A small rodent.', null], ['A pointing device.', 'was 3rd'], ['A shy person.', 'was 2nd'], '—', ['A black eye.', null], ['A knot on a rope.', null]])
    toggle(card).click()
    expect(shadow(card).querySelector('[data-part="unranked"]')).toBeNull()
  })

  test('meanings after the divider carry no tag, and an entry offered nothing starts with it', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor, { status: 'ordered', positions: [[0, 1, 2, 4, 3], [0]], offered: [0, 0] })
    expect(rows(card)).toEqual(['—', ['A small rodent.', null], ['A pointing device.', null], ['A shy person.', null]])
    toggle(card).click()
    expect(rows(card).slice(-2)).toEqual([['A black eye.', null], ['A knot on a rope.', null]])
    expect(rows(card, 1)).toEqual(['—', ['To hunt mice.', null]])
  })

  test('the divider is not a numbered meaning', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor, { status: 'ordered', positions: [[1, 0, 2, 3, 4], [0]], offered: [2, 1] })
    const css = shadow(card).querySelector('style')!.textContent!
    expect(css).toMatch(/\.dc-unranked\s*\{[^}]*display:\s*block/)
  })

  test('large positions read as English ordinals', () => {
    const { card } = makeCard()
    const long = result({ entries: [{ lemma: 'set', partOfSpeech: 'verb', senses: Array.from({ length: 23 }, (_, i) => ({ definition: `meaning ${i}`, examples: [] })) }] })
    const positions = [[21, 10, 11, 12, 22, ...Array.from({ length: 23 }, (_, i) => i).filter(i => ![21, 10, 11, 12, 22].includes(i))]]
    card.showResult(long, anchor, { status: 'ordered', positions, offered: [23] })
    expect(texts(card, '[data-part="was"]')).toEqual(['was 22nd', 'was 11th', 'was 12th'])
    toggle(card).click()
    expect(texts(card, '[data-part="was"]').slice(0, 5)).toEqual(['was 22nd', 'was 11th', 'was 12th', 'was 13th', 'was 23rd'])
  })

  test('no score, percentage or timing appears with details', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor, { status: 'ordered', positions: [[1, 0, 2, 4, 3], [0]], offered: [2, 1] })
    for (const part of ['order-status', 'unranked']) expect(shadow(card).querySelector(`[data-part="${part}"]`)!.textContent).not.toMatch(/[\d%]/)
    for (const tag of texts(card, '[data-part="was"]')) expect(tag).toMatch(/^was \d+(st|nd|rd|th)$/)
  })

  test('no score appears in the tag of an entry either', () => {
    const { card } = makeCard()
    const [noun, verb] = result().entries
    card.showResult(result({ entries: [verb!, noun!] }), anchor, { status: 'ordered', positions: [[0], [1, 0, 2, 3, 4]], offered: [1, 5], entryPositions: [1, 0] })
    expect(texts(card, '[data-part="entry-was"]')).toEqual(['was 2nd entry'])
    for (const tag of texts(card, '[data-part="entry-was"]')) expect(tag).toMatch(/^was \d+(st|nd|rd|th) entry$/)
  })

  test('an entry moved first carries "was" and its dictionary position among the entries on its heading; the others carry nothing', () => {
    const { card } = makeCard()
    const [noun, verb] = result().entries
    const adj = { lemma: 'mousy', partOfSpeech: 'adj', senses: [{ definition: 'Shy and quiet.', examples: [] }, { definition: 'Of a dull brown colour.', examples: [] }] }
    // In dictionary order: noun, verb, adjective. The adjective moved first; no meaning moved inside its entry.
    const details: OrderDetails = { status: 'ordered', positions: [[0, 1], [0, 1, 2, 3, 4], [0]], offered: [2, 5, 1], entryPositions: [2, 0, 1] }
    card.showResult(result({ entries: [adj, noun!, verb!] }), anchor, details)
    const heads = [...shadow(card).querySelectorAll('section.dc-entry .dc-head')]
    expect(heads.map(head => head.querySelector('[data-part="entry-was"]')?.textContent ?? null)).toEqual(['was 3rd entry', null, null])
    expect([...heads[0]!.children].map(child => child.getAttribute('data-part'))).toEqual(['lemma', 'pos', 'entry-was'])
    expect(heads[0]!.querySelector('[data-part="entry-was"]')!.className).toBe('dc-was')
    expect(texts(card, '[data-part="was"]')).toEqual([])
    expect(statusLine(card)!.textContent).toBe('Ordered by context')
    toggle(card).click()
    expect(texts(card, '[data-part="entry-was"]')).toEqual(['was 3rd entry'])
    // Entry positions that keep every entry in place tag nothing.
    card.showResult(result(), anchor, { ...moved, entryPositions: [0, 1] })
    expect(texts(card, '[data-part="entry-was"]')).toEqual([])
    // With the switch off the controller passes no details: no tag, no status line.
    card.showResult(result({ entries: [adj, noun!, verb!] }), anchor)
    expect(texts(card, '[data-part="entry-was"], [data-part="order-status"]')).toEqual([])
  })

  test('order annotations use the shared card classes and contain text alone', () => {
    const { card } = makeCard()
    card.showResult(result(), anchor, { status: 'ordered', positions: [[1, 0, 2, 3, 4], [0]], offered: [2, 1] })
    for (const part of ['was', 'unranked', 'status']) expect(shadow(card).querySelector(`.dc-${part}`)!.children).toHaveLength(0)
  })
})
