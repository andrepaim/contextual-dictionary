// Watches the page's selection and shows the definition card for a word or a
// short phrase. One lookup at a time: a new selection or a dismissal cancels
// the one in flight, and a late answer is dropped. See docs/plan.md section 5.5.
import type { Backend, DictionaryResult, OrderDetails, Selection, Settings } from '../shared/contracts'
import { BACKEND_ERRORS } from './backend'
import { Card, type DismissReason } from './card'
import { anchorRect, readSelection, type Rect } from './selection'

/** What the controller needs of the card; tests may substitute one. */
export interface CardLike {
  readonly state: 'hidden' | 'placeholder' | 'card'
  showPlaceholder(anchor: () => Rect | null, query: string): void
  showResult(result: DictionaryResult, anchor: () => Rect | null, details?: OrderDetails): void
  hide(): void
  contains(target: EventTarget | null): boolean
  destroy(): void
}

/** The part of a Status the controller acts on. */
export interface ActivationState { settings: Pick<Settings, 'definitions' | 'showOrderDetails'>; siteEnabled: boolean }

export interface ControllerOptions {
  backend: Backend
  /** The page's host name, sent with the status request. */
  host: string
  window?: Window
  /** Makes the card; defaults to the shadow-DOM Card. */
  createCard?: (options: { document: Document; onDismiss: (reason: DismissReason) => void }) => CardLike
  /** Wait after mouseup or dblclick before reading the selection, in ms. */
  mouseDelayMs?: number
  /** Quiet time after the last selectionchange before a keyboard selection is read, in ms. */
  keyboardDelayMs?: number
  /** Request identifiers; the default is unique within the page. */
  requestId?: () => string
}

interface Lookup {
  key: string
  id: string
  abort: AbortController
  /** The answer arrived (shown or empty) or the lookup failed. */
  settled: boolean
}

let counter = 0
const defaultRequestId = () => `${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * The selected range, looking inside the open shadow root that holds `target`
 * (where the mouse was released, or the focused element) as far as the
 * browser exposes it.
 */
function rangeFor(view: Window, target: EventTarget | null): Range | null {
  const root = target instanceof Node ? target.getRootNode() : null
  if (root instanceof ShadowRoot) {
    // Chromium's ShadowRoot.getSelection, then the standard getComposedRanges.
    const own = (root as ShadowRoot & { getSelection?: () => globalThis.Selection | null }).getSelection?.()
    if (own && own.rangeCount && !own.isCollapsed) return own.getRangeAt(0)
    const selection = view.getSelection() as (globalThis.Selection & { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[] }) | null
    const composed = selection?.getComposedRanges?.({ shadowRoots: [root] })[0]
    if (composed && !composed.collapsed) {
      const range = root.ownerDocument.createRange()
      range.setStart(composed.startContainer, composed.startOffset)
      range.setEnd(composed.endContainer, composed.endOffset)
      return range
    }
  }
  const selection = view.getSelection()
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null
  return selection.getRangeAt(0)
}

/** The focused element, looking into open shadow roots. */
function focusedElement(doc: Document): Element | null {
  let element = doc.activeElement
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
  return element
}

export class Controller {
  readonly #backend: Backend
  readonly #host: string
  readonly #window: Window
  readonly #createCard: NonNullable<ControllerOptions['createCard']>
  readonly #mouseDelay: number
  readonly #keyboardDelay: number
  readonly #requestId: () => string
  #card: CardLike | null = null
  #lookup: Lookup | null = null
  #enabled = false
  /** Whether cards show what the model did to the order; read when a lookup starts. */
  #showDetails = false
  #attached = false
  #stopped = false
  #pointerDown = false
  #mouseTimer: ReturnType<typeof setTimeout> | undefined
  #keyboardTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ControllerOptions) {
    this.#backend = options.backend
    this.#host = options.host
    this.#window = options.window ?? window
    this.#createCard = options.createCard ?? (cardOptions => new Card(cardOptions))
    this.#mouseDelay = options.mouseDelayMs ?? 10
    this.#keyboardDelay = options.keyboardDelayMs ?? 400
    this.#requestId = options.requestId ?? defaultRequestId
  }

  /** Whether selections are being watched. */
  get active(): boolean { return this.#attached }

  /** Asks the back end whether to run here, then watches selections if so. */
  async start(): Promise<void> {
    this.#window.addEventListener('pagehide', this.#onPageHide)
    this.#window.addEventListener('pageshow', this.#onPageShow)
    await this.refresh()
  }

  /** Asks for the status again and applies it; the hook for a settings change. */
  async refresh(): Promise<void> {
    if (this.#stopped) return
    try {
      this.apply(await this.#backend.send({ type: 'status', host: this.#host }))
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Applies settings pushed by the back end: on when definitions are on and the site is enabled. */
  apply(state: ActivationState): void {
    if (this.#stopped) return
    this.#enabled = state.settings.definitions && state.siteEnabled
    this.#showDetails = state.settings.showOrderDetails === true
    this.#attach(this.#enabled)
  }

  /** Stops for good: cancels the lookup, removes the card and every listener. */
  stop(): void {
    this.#stopped = true
    this.#attach(false)
    this.#window.removeEventListener('pagehide', this.#onPageHide)
    this.#window.removeEventListener('pageshow', this.#onPageShow)
  }

  #fail(error: unknown): void {
    // An orphaned content script (the extension was reloaded) can never reach
    // the back end again. Anything else leaves the page as it was.
    if ((error as { code?: string })?.code === BACKEND_ERRORS.invalidated) this.stop()
    else this.#attach(false)
  }

  #attach(on: boolean): void {
    if (!on) this.#cancel()
    if (on === this.#attached) return
    this.#attached = on
    const doc = this.#window.document
    const method = on ? 'addEventListener' : 'removeEventListener'
    // Capture, so pages that stop these events still let the card work.
    this.#window[method]('mousedown', this.#onMouseDown, true)
    this.#window[method]('mouseup', this.#onMouseUp, true)
    this.#window[method]('dblclick', this.#onMouseUp, true)
    doc[method]('selectionchange', this.#onSelectionChange)
    if (!on) {
      clearTimeout(this.#mouseTimer)
      clearTimeout(this.#keyboardTimer)
      this.#card?.destroy()
      this.#card = null
    }
  }

  #onPageHide = () => { this.#attach(false) }

  #onPageShow = (event: Event) => {
    // Back from the back/forward cache: settings may have changed meanwhile.
    if ((event as PageTransitionEvent).persisted) void this.refresh()
  }

  #onMouseDown = (event: Event) => {
    if ((event as MouseEvent).button !== 0) return
    if (this.#card?.contains(event.composedPath()[0] ?? event.target)) return
    this.#pointerDown = true
    clearTimeout(this.#keyboardTimer)
  }

  #onMouseUp = (event: Event) => {
    this.#pointerDown = false
    // The event's path is gone once its dispatch ends, so keep the innermost target.
    const target = event.composedPath()[0] ?? event.target
    if (this.#card?.contains(target)) return
    clearTimeout(this.#mouseTimer)
    this.#mouseTimer = setTimeout(() => this.#check(target, true), this.#mouseDelay)
  }

  #onSelectionChange = () => {
    // A mouse selection is read once at mouseup.
    if (this.#pointerDown) return
    clearTimeout(this.#keyboardTimer)
    this.#keyboardTimer = setTimeout(() => this.#check(focusedElement(this.#window.document), false), this.#keyboardDelay)
  }

  /** Reads the current selection and starts, keeps or cancels a lookup. */
  #check(target: EventTarget | null, byMouse: boolean): void {
    if (!this.#attached) return
    const range = rangeFor(this.#window, target)
    if (!range) {
      // Nothing selected. A mouse click outside already dismissed the card;
      // a selection cleared from the keyboard does it here.
      if (!byMouse && this.#lookup) this.#cancel()
      // A lookup that ended without a card (an error, an unknown word) is
      // forgotten once the selection is gone, so selecting the same word
      // again asks again, for example after the dictionary was installed.
      else if (this.#lookup?.settled && this.#card?.state !== 'card') this.#lookup = null
      return
    }
    const selection = readSelection(range, focusedElement(this.#window.document))
    if (!selection) { this.#cancel(); return }
    const key = JSON.stringify([selection.text, selection.before, selection.after])
    // The two clicks of a double-click, or the same selection seen again.
    if (this.#lookup?.key === key) return
    this.#cancel()
    this.#define(selection, key, () => anchorRect(range))
  }

  #define(selection: Selection, key: string, anchor: () => Rect | null): void {
    const lookup: Lookup = { key, id: this.#requestId(), abort: new AbortController(), settled: false }
    const showDetails = this.#showDetails
    this.#lookup = lookup
    const card = this.#card ??= this.#createCard({ document: this.#window.document, onDismiss: () => this.#cancel() })
    card.showPlaceholder(anchor, selection.text)
    this.#backend.send({ type: 'define', requestId: lookup.id, selection }, lookup.abort.signal).then(answer => {
      if (this.#lookup !== lookup || lookup.settled) return
      lookup.settled = true
      // One final render; an unknown word shows nothing.
      if (showDetails) card.showResult(answer.result, anchor, answer.order)
      else card.showResult(answer.result, anchor)
    }, error => {
      if (this.#lookup !== lookup) return
      lookup.settled = true
      card.hide()
      if ((error as { code?: string })?.code === BACKEND_ERRORS.invalidated) this.stop()
    })
  }

  /** Cancels the lookup in flight, if any, and hides the card. */
  #cancel(): void {
    const lookup = this.#lookup
    this.#lookup = null
    if (lookup && !lookup.settled) {
      lookup.abort.abort()
      this.#backend.send({ type: 'cancel-define', requestId: lookup.id }).catch(() => { /* best effort */ })
    }
    if (this.#card && this.#card.state !== 'hidden') this.#card.hide()
  }
}
