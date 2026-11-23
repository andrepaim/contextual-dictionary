// The definition card: a placeholder that appears at once, then the meanings.
// It lives in a shadow root on one host element, so page styles do not reach
// it and its styles do not reach the page. All dictionary and page text is set
// with textContent. See docs/plan.md section 5.5.
import type { DictionaryEntry, DictionaryResult } from '../shared/contracts'
import type { Rect } from './selection'

export type { Rect } from './selection'

/** Meanings shown per entry before "Show all meanings". */
export const MEANINGS_SHOWN = 3
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

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.surface {
  --bg: #ffffff; --text: #1f2328; --muted: #59636e; --border: #d0d7de; --accent: #0969da; --shadow: 0 8px 24px rgba(31, 35, 40, 0.18);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
  text-align: left; letter-spacing: normal; text-transform: none; white-space: normal; direction: ltr;
}
@media (prefers-color-scheme: dark) {
  .surface { --bg: #22272e; --text: #e6edf3; --muted: #9aa5b1; --border: #444c56; --accent: #6cb6ff; --shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
}
.placeholder { display: flex; gap: 4px; align-items: center; padding: 8px 10px; border-radius: 999px; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); opacity: 0.35; animation: pulse 1s infinite ease-in-out; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes pulse { 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; opacity: 0.6; } }
.card { display: flex; flex-direction: column; width: 340px; max-width: calc(100vw - ${2 * MARGIN}px); max-height: ${MAX_HEIGHT}px; outline: none; }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 10px 14px 4px; }
.entry { margin: 0 0 10px; }
.head { margin: 0; }
.lemma { font-weight: 600; font-size: 15px; }
.pos { color: var(--muted); font-style: italic; font-size: 13px; margin-left: 6px; }
.note { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
ol { margin: 4px 0 0; padding: 0 0 0 22px; list-style: decimal; }
li { margin: 0 0 4px; padding: 0; }
li::marker { color: var(--muted); }
.example { display: block; color: var(--muted); font-size: 13px; margin-top: 1px; }
.footer { display: flex; align-items: center; gap: 12px; padding: 6px 14px 8px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.toggle { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
.toggle:hover { text-decoration: underline; }
.attribution { margin-left: auto; color: var(--muted); text-decoration: none; }
a.attribution:hover { text-decoration: underline; }
.toggle:focus-visible, a.attribution:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
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
    const placeholder = this.#element('div', 'surface placeholder')
    placeholder.dataset.part = 'placeholder'
    placeholder.setAttribute('role', 'status')
    placeholder.setAttribute('aria-label', `Looking up “${query}”`)
    for (let index = 0; index < 3; index++) placeholder.append(this.#element('span', 'dot'))
    this.#show(placeholder, anchor, 'placeholder')
  }

  /** The meanings of `result`, in the order received; no card when it has no entries. */
  showResult(result: DictionaryResult, anchor: Anchor): void {
    if (!result.entries.length) { this.hide(); return }
    const card = this.#element('div', 'surface card')
    card.dataset.part = 'card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', `Definitions of “${result.query}”`)
    card.setAttribute('lang', 'en')
    card.tabIndex = -1
    const body = this.#element('div', 'body')
    const footer = this.#element('div', 'footer')
    card.append(body, footer)
    const hidden = result.entries.some(entry => entry.senses.length > MEANINGS_SHOWN)
    let showAll = false
    const fill = () => body.replaceChildren(...result.entries.map(entry => this.#entry(entry, showAll)))
    fill()
    if (hidden) {
      const toggle = this.#element('button', 'toggle')
      toggle.dataset.part = 'toggle'
      toggle.setAttribute('type', 'button')
      const label = () => {
        toggle.textContent = showAll ? 'Show fewer' : 'Show all meanings'
        toggle.setAttribute('aria-expanded', String(showAll))
      }
      label()
      toggle.addEventListener('click', () => { showAll = !showAll; fill(); label(); this.#place() })
      footer.append(toggle)
    }
    const credit = `${result.source.name} · ${result.source.license}`
    const attribution = isWebAddress(result.source.url) ? this.#element('a', 'attribution') : this.#element('span', 'attribution')
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

  #entry(entry: DictionaryEntry, showAll: boolean): HTMLElement {
    const section = this.#element('section', 'entry')
    const head = this.#element('div', 'head')
    const lemma = this.#element('span', 'lemma')
    lemma.dataset.part = 'lemma'
    lemma.textContent = entry.lemma
    const pos = this.#element('span', 'pos')
    pos.dataset.part = 'pos'
    pos.textContent = entry.partOfSpeech
    head.append(lemma, pos)
    section.append(head)
    if (entry.note) {
      const note = this.#element('p', 'note')
      note.dataset.part = 'note'
      note.textContent = entry.note
      section.append(note)
    }
    const list = this.#element('ol')
    for (const sense of showAll ? entry.senses : entry.senses.slice(0, MEANINGS_SHOWN)) {
      const item = this.#element('li')
      const definition = this.#element('span', 'definition')
      definition.dataset.part = 'definition'
      definition.textContent = sense.definition
      item.append(definition)
      for (const text of sense.examples) {
        const example = this.#element('span', 'example')
        example.dataset.part = 'example'
        example.textContent = `“${text}”`
        item.append(example)
      }
      list.append(item)
    }
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
    sheet.textContent = STYLES
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
