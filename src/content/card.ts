// The definition card: a placeholder that appears at once, then the meanings.
// It lives in a shadow root on one host element, so page styles do not reach
// it and its styles do not reach the page. All dictionary and page text is set
// with textContent. See docs/plan.md section 5.5.
import { cardPreview, type CardPreviewEntry } from '@andrepaim/contextual-dictionary-core/card'
import cardCss from '@andrepaim/contextual-dictionary-core/card.css?inline'
import type { DictionaryResult, OrderDetails } from '../shared/contracts'
import { ordinal, orderStatusText, usableDetails } from './order-details'
import type { Rect } from './selection'

export type { Rect } from './selection'

export const HOST_TAG = 'contextual-dictionary-card'
const MARGIN = 8
const GAP = 8
const MAX_HEIGHT = 360

export interface Placement { left: number; top: number; maxHeight: number; placement: 'below' | 'above' }

/**
 * Where the card goes: below the selection, or above it when there is no
 * room below, and inside the viewport horizontally. When neither side has
 * room it takes the larger one and limits its height to fit.
 */
export function placeCard(anchor: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }): Placement {
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN))
  const below = viewport.height - (anchor.bottom + GAP) - MARGIN
  const above = anchor.top - GAP - MARGIN
  const side = below >= size.height || (above < size.height && below >= above) ? 'below' : 'above'
  if (side === 'below') return { left, top: anchor.bottom + GAP, maxHeight: Math.max(0, below), placement: 'below' }
  const height = Math.min(size.height, above)
  return { left, top: anchor.top - GAP - height, maxHeight: Math.max(0, above), placement: 'above' }
}

const HOST_STYLES = `
:host { all: initial; }
.dc-card {
  /* The shared theme variables can otherwise inherit from the page. */
  --dc-bg: initial; --dc-text: initial; --dc-muted: initial;
  --dc-border: initial; --dc-accent: initial; --dc-shadow: initial;
  max-width: calc(100vw - ${2 * MARGIN}px);
  max-height: ${MAX_HEIGHT}px;
}
.placeholder {
  --placeholder-bg: #ffffff; --placeholder-border: #d0d7de; --placeholder-dot: #59636e;
  --placeholder-shadow: 0 8px 24px rgba(31, 35, 40, 0.18);
  display: flex; gap: 4px; align-items: center; padding: 8px 10px; border-radius: 999px;
  background: var(--placeholder-bg); border: 1px solid var(--placeholder-border); box-shadow: var(--placeholder-shadow);
}
@media (prefers-color-scheme: dark) {
  .placeholder {
    --placeholder-bg: #22272e; --placeholder-border: #444c56; --placeholder-dot: #9aa5b1;
    --placeholder-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
}
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--placeholder-dot); opacity: 0.35; animation: pulse 1s infinite ease-in-out; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes pulse { 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; opacity: 0.6; } }
`

export type CardState = 'hidden' | 'placeholder' | 'card'
export type DismissReason = 'escape' | 'outside'

export interface CardOptions {
  document?: Document
  /** Called when the reader closes the card with Escape or a click outside it. */
  onDismiss?: (reason: DismissReason) => void
}

type Anchor = () => Rect | null

const isWebAddress = (url: string) => {
  try { return ['https:', 'http:'].includes(new URL(url).protocol) } catch { return false }
}

export class Card {
  /** The page element that holds the shadow root; null until first shown. */
  host: HTMLElement | null = null
  readonly #document: Document
  readonly #onDismiss: (reason: DismissReason) => void
  #root: ShadowRoot | null = null
  #content: HTMLElement | null = null
  #state: CardState = 'hidden'
  #anchor: Anchor = () => null
  #frame = 0
  #listening = false

  constructor(options: CardOptions = {}) {
    this.#document = options.document ?? document
    this.#onDismiss = options.onDismiss ?? (() => {})
  }

  get state(): CardState { return this.#state }

  /** A small, quiet sign that a lookup is under way. */
  showPlaceholder(anchor: Anchor, query: string): void {
    const placeholder = this.#element('div', 'placeholder')
    placeholder.dataset.part = 'placeholder'
    placeholder.setAttribute('role', 'status')
    placeholder.setAttribute('aria-label', `Looking up “${query}”`)
    for (let index = 0; index < 3; index++) placeholder.append(this.#element('span', 'dot'))
    this.#show(placeholder, anchor, 'placeholder')
  }

  /** Shows the result in order, with context ordering details when available. */
  showResult(result: DictionaryResult, anchor: Anchor, details?: OrderDetails): void {
    if (!result.entries.length) { this.hide(); return }
    const order = details === undefined ? undefined : usableDetails(result, details)
    const card = this.#element('div', 'dc-card')
    card.dataset.part = 'card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', `Definitions of “${result.query}”`)
    card.setAttribute('lang', 'en')
    card.tabIndex = -1
    const body = this.#element('div', 'dc-body')
    body.id = 'definition-card-body'
    const footer = this.#element('div', 'dc-footer')
    card.append(body, footer)
    let expanded = false
    const fill = () => {
      const preview = cardPreview(result.entries, expanded)
      body.replaceChildren(...preview.entries.map((entry, index) => this.#entry(entry, order?.positions?.[index], order?.offered?.[index], order?.entryPositions?.[index], index)))
      return preview.canExpand
    }
    const canExpand = fill()
    if (order) {
      const line = this.#element('p', 'dc-status')
      line.dataset.part = 'order-status'
      line.textContent = orderStatusText(order)
      footer.append(line)
    }
    if (canExpand) {
      const toggle = this.#element('button', 'dc-toggle')
      toggle.dataset.part = 'toggle'
      toggle.type = 'button'
      toggle.setAttribute('aria-controls', body.id)
      const label = () => {
        toggle.textContent = expanded ? 'Show fewer' : 'Show all meanings'
        toggle.setAttribute('aria-expanded', String(expanded))
      }
      label()
      toggle.addEventListener('click', () => {
        expanded = !expanded
        fill()
        label()
        this.#place()
      })
      footer.append(toggle)
    }
    const credit = `${result.source.name} · ${result.source.license}`
    const attribution = isWebAddress(result.source.url) ? this.#element('a', 'dc-attribution') : this.#element('span', 'dc-attribution')
    attribution.dataset.part = 'attribution'
    attribution.textContent = credit
    if (attribution instanceof HTMLAnchorElement) {
      attribution.href = result.source.url
      attribution.target = '_blank'
      attribution.rel = 'noopener noreferrer'
    }
    footer.append(attribution)
    this.#show(card, anchor, 'card')
  }

  hide(): void {
    this.#state = 'hidden'
    this.#listen(false)
    if (this.host) this.host.style.setProperty('display', 'none', 'important')
    this.#content?.replaceChildren()
  }

  /** Whether `target` (an event target) is the card or inside it. */
  contains(target: EventTarget | null): boolean {
    if (!this.host || !(target instanceof Node)) return false
    return target === this.host || this.host.contains(target) || this.#root!.contains(target)
  }

  destroy(): void {
    this.hide()
    this.host?.remove()
    this.host = null
    this.#root = null
    this.#content = null
  }

  #element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const element = this.#document.createElement(tag)
    if (className) element.className = className
    return element
  }

  /**
   * Renders the entry at `entryPlace` on the card, with dictionary positions when
   * the context model reordered it, and the entry's dictionary position when the
   * model moved it up.
   */
  #entry({ entry, senses }: CardPreviewEntry, positions?: number[], offered?: number, entryPosition?: number, entryPlace = 0): HTMLElement {
    const section = this.#element('section', 'dc-entry')
    const head = this.#element('div', 'dc-head')
    const lemma = this.#element('span', 'dc-lemma')
    lemma.dataset.part = 'lemma'
    lemma.textContent = entry.lemma
    const pos = this.#element('span', 'dc-pos')
    pos.dataset.part = 'pos'
    pos.textContent = entry.partOfSpeech
    head.append(lemma, pos)
    if (entryPosition !== undefined && entryPosition > entryPlace) {
      // The entry holding the model's best meaning moved up; the entries it passed keep dictionary order and carry nothing.
      const tag = this.#element('span', 'dc-was')
      tag.dataset.part = 'entry-was'
      tag.textContent = `was ${ordinal(entryPosition + 1)} entry`
      head.append(tag)
    }
    section.append(head)
    if (entry.note) {
      const note = this.#element('p', 'dc-note')
      note.dataset.part = 'note'
      note.textContent = entry.note
      section.append(note)
    }
    const list = this.#element('ol', 'dc-senses')
    senses.forEach(({ sense, examples }, place) => {
      if (positions && place === offered) {
        // The meanings from here on were not offered to the model; they keep dictionary order.
        const divider = this.#element('li', 'dc-unranked')
        divider.dataset.part = 'unranked'
        divider.textContent = 'Not seen by the model'
        list.append(divider)
      }
      const item = this.#element('li')
      const definition = this.#element('span', 'dc-definition')
      definition.dataset.part = 'definition'
      definition.textContent = sense.definition
      item.append(definition)
      const was = positions?.[place]
      if (was !== undefined && offered !== undefined && place < offered && was !== place) {
        const tag = this.#element('span', 'dc-was')
        tag.dataset.part = 'was'
        tag.textContent = `was ${ordinal(was + 1)}`
        item.append(tag)
      }
      for (const text of examples) {
        const example = this.#element('span', 'dc-example')
        example.dataset.part = 'example'
        example.textContent = `“${text}”`
        item.append(example)
      }
      list.append(item)
    })
    section.append(list)
    return section
  }

  #ensureHost(): HTMLElement {
    if (this.host) return this.host
    const host = this.#document.createElement(HOST_TAG)
    const style = host.style
    style.setProperty('all', 'initial', 'important')
    for (const [name, value] of [
      ['position', 'fixed'], ['z-index', '2147483647'], ['display', 'block'], ['left', `${MARGIN}px`], ['top', `${MARGIN}px`],
      ['margin', '0'], ['padding', '0'], ['border', '0'], ['width', 'auto'], ['height', 'auto'], ['transform', 'none'],
    ] as const) style.setProperty(name, value, 'important')
    this.#root = host.attachShadow({ mode: 'open' })
    const sheet = this.#element('style')
    sheet.textContent = `${cardCss}\n${HOST_STYLES}`
    this.#content = this.#element('div')
    // A press inside the card keeps the page selection, so the word stays selected.
    this.#content.addEventListener('mousedown', event => event.preventDefault())
    this.#root.append(sheet, this.#content)
    this.#document.documentElement.append(host)
    this.host = host
    return host
  }

  #show(element: HTMLElement, anchor: Anchor, state: CardState): void {
    const host = this.#ensureHost()
    this.#anchor = anchor
    this.#state = state
    this.#content!.replaceChildren(element)
    host.style.setProperty('display', 'block', 'important')
    this.#place()
    this.#listen(true)
  }

  #place(): void {
    const host = this.host
    const surface = this.#content?.firstElementChild as HTMLElement | null
    if (!host || !surface || this.#state === 'hidden') return
    const anchor = this.#anchor()
    if (!anchor) return
    const view = this.#document.defaultView
    const root = this.#document.documentElement
    const viewport = { width: root.clientWidth || view?.innerWidth || 0, height: root.clientHeight || view?.innerHeight || 0 }
    surface.style.maxHeight = ''
    const box = surface.getBoundingClientRect()
    const place = placeCard(anchor, { width: box.width, height: box.height }, viewport)
    if (this.#state === 'card') surface.style.maxHeight = `${Math.min(MAX_HEIGHT, place.maxHeight)}px`
    host.style.setProperty('left', `${Math.round(place.left)}px`, 'important')
    host.style.setProperty('top', `${Math.round(place.top)}px`, 'important')
  }

  #onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    this.hide()
    this.#onDismiss('escape')
  }

  #onPress = (event: Event) => {
    if (this.host && event.composedPath().includes(this.host)) return
    this.hide()
    this.#onDismiss('outside')
  }

  #onMove = () => {
    const view = this.#document.defaultView
    if (this.#frame || !view) return
    this.#frame = view.requestAnimationFrame(() => { this.#frame = 0; this.#place() })
  }

  #listen(on: boolean): void {
    if (on === this.#listening) return
    this.#listening = on
    const doc = this.#document, view = doc.defaultView
    const method = on ? 'addEventListener' : 'removeEventListener'
    doc[method]('keydown', this.#onKey as EventListener, true)
    doc[method]('mousedown', this.#onPress, true)
    doc[method]('scroll', this.#onMove, { capture: true, passive: true } as AddEventListenerOptions)
    view?.[method]('resize', this.#onMove, { passive: true } as AddEventListenerOptions)
    if (!on && this.#frame) { view?.cancelAnimationFrame(this.#frame); this.#frame = 0 }
  }
}
