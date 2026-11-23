// The toolbar popup: a view over the back end's Status. Switches for
// definitions, ordering and the current site; for each download, its consent
// with the exact size, progress, cancel, retry and removal. See docs/plan.md
// section 5.5.
import type { Backend, BundleName, BundleStatus, Request, Status } from '../shared/contracts'

/** Plain-language text for every code the popup can meet. */
export const ERROR_MESSAGES: Record<string, string> = {
  DOWNLOAD_FAILED: 'The download failed. Check your connection and try again.',
  DOWNLOAD_STALLED: 'The download stopped making progress. Check your connection and try again.',
  DOWNLOAD_CANCELLED: 'The download was cancelled.',
  DOWNLOAD_SIZE_CHANGED: 'The download size has changed. Check the new size and confirm again.',
  DOWNLOAD_UNAVAILABLE: 'The files cannot be downloaded right now. Try again later.',
  ASSET_CORRUPT: 'The downloaded file was damaged, so it was discarded. Try again.',
  ASSET_MISMATCH: 'The downloaded file did not match the published one, so it was discarded. Try again.',
  DISK_FULL: 'There is not enough free disk space. Free some space and try again.',
  INSTALL_FAILED: 'The files could not be installed. Try again.',
  MODEL_MISMATCH: 'The installed model is not the expected version. Remove it and download it again.',
  RUNTIME_FAILED: 'The model runtime could not start in this browser.',
  SESSION_FAILED: 'The model could not be loaded.',
  LOAD_TIMEOUT: 'The model took too long to start.',
  WORKER_ERROR: 'The model stopped unexpectedly.',
  NO_RESPONSE: 'The extension is not responding. Close this window and open it again.',
  CONTEXT_INVALIDATED: 'The extension was updated. Close this window and open it again.',
}

export function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? `Something went wrong (${code}). Try again.`
}

/** Bytes as megabytes with one decimal: the exact size the reader agrees to. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

const NAMES: Record<BundleName, { title: string; noun: string; description: string }> = {
  dictionary: { title: 'Dictionary', noun: 'dictionary', description: 'English Wiktionary, for the definitions.' },
  model: { title: 'Context model', noun: 'model', description: 'Ettin-150m-WSD, for “Order by context”. It runs on this computer.' },
}

const CREDITS: Array<string | { text: string; href: string }> = [
  'Definitions from ', { text: 'Wiktionary', href: 'https://en.wiktionary.org/' }, ', under ',
  { text: 'CC BY-SA 4.0', href: 'https://creativecommons.org/licenses/by-sa/4.0/' }, '. Meanings ordered by ',
  { text: 'Ettin-150m-WSD', href: 'https://huggingface.co/sign/Ettin-150m-WSD' }, ' (Apache-2.0), run with ',
  { text: 'ONNX Runtime', href: 'https://github.com/microsoft/onnxruntime' }, ' (MIT). What you select never leaves this computer.',
]

const busyPhase = (bundle: BundleStatus) => bundle.phase === 'downloading' || bundle.phase === 'installing'

export interface PopupOptions {
  /** The element the view renders into. */
  root: HTMLElement
  backend: Backend
  /** The active tab's host name, or null when it is not an ordinary web page. */
  host?: string | null
  /** How often to ask for the status while something is in progress, in ms. */
  pollMs?: number
}

export class PopupView {
  readonly #root: HTMLElement
  readonly #backend: Backend
  readonly #host: string | null
  readonly #pollMs: number
  #status: Status | null = null
  #busy = false
  #consent = false
  /** The bundle whose removal is being confirmed. */
  #confirmRemove: BundleName | null = null
  #problem = ''
  #timer: ReturnType<typeof setTimeout> | undefined
  #destroyed = false

  constructor(options: PopupOptions) {
    this.#root = options.root
    this.#backend = options.backend
    this.#host = options.host ?? null
    this.#pollMs = options.pollMs ?? 500
  }

  async start(): Promise<void> {
    await this.#refresh()
    this.#render()
  }

  destroy(): void {
    this.#destroyed = true
    clearTimeout(this.#timer)
  }

  #statusRequest(): Extract<Request, { type: 'status' }> {
    return this.#host ? { type: 'status', host: this.#host } : { type: 'status' }
  }

  async #refresh(): Promise<void> {
    try {
      this.#status = await this.#backend.send(this.#statusRequest())
    } catch (error) {
      this.#problem = errorMessage((error as { code?: string }).code ?? 'NO_RESPONSE')
    }
  }

  /** Runs one action that answers with a Status, then shows the result. */
  async #act(work: () => Promise<Status>): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#problem = ''
    this.#render()
    try {
      this.#status = await work()
    } catch (error) {
      this.#problem = errorMessage((error as { code?: string }).code ?? 'NO_RESPONSE')
      // Show the state the back end is really in, for example a new size.
      const problem = this.#problem
      await this.#refresh()
      this.#problem = problem
    } finally {
      this.#busy = false
    }
    this.#render()
  }

  #poll(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const status = this.#status
    if (this.#destroyed || !status) return
    const pending = busyPhase(status.bundles.dictionary) || busyPhase(status.bundles.model) || status.ranker.state === 'loading'
    if (!pending) return
    this.#timer = setTimeout(async () => {
      this.#timer = undefined
      if (this.#destroyed) return
      try { this.#status = await this.#backend.send(this.#statusRequest()) } catch { /* the next render keeps the last status */ }
      if (!this.#busy) this.#render()
      else this.#poll()
    }, this.#pollMs)
  }

  // ----------------------------------------------------------------- render

  #render(): void {
    if (this.#destroyed) return
    const focusedKey = (this.#root.ownerDocument.activeElement as HTMLElement | null)?.dataset?.key
    const status = this.#status
    const parts: Node[] = [this.#heading()]
    if (status) {
      parts.push(this.#switches(status))
      if (this.#consent && !busyPhase(status.bundles.model) && status.bundles.model.phase !== 'ready') parts.push(this.#consentBlock(status))
      else this.#consent = false
      parts.push(this.#bundle('dictionary', status), this.#bundle('model', status))
    }
    if (this.#problem) {
      const problem = this.#el('p', 'problem', this.#problem)
      problem.dataset.part = 'problem'
      problem.setAttribute('role', 'alert')
      parts.push(problem)
    }
    parts.push(this.#credits())
    this.#root.replaceChildren(...parts)
    if (this.#busy) for (const control of this.#root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = true
    if (focusedKey) this.#root.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`)?.focus()
    this.#poll()
  }

  #el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const element = this.#root.ownerDocument.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  #button(label: string, key: string, onClick: () => void, options: { ariaLabel?: string; primary?: boolean } = {}): HTMLButtonElement {
    const button = this.#el('button', options.primary ? 'button primary' : 'button', label)
    button.type = 'button'
    button.dataset.key = key
    if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel)
    button.addEventListener('click', onClick)
    return button
  }

  #heading(): HTMLElement {
    return this.#el('h1', 'title', 'Contextual Dictionary')
  }

  #switch(name: string, label: string, checked: boolean, onChange: (checked: boolean) => void, disabled = false): HTMLElement {
    const row = this.#el('label', 'switch-row')
    const input = this.#el('input', 'switch')
    input.type = 'checkbox'
    input.setAttribute('role', 'switch')
    input.dataset.control = name
    input.dataset.key = `switch:${name}`
    input.checked = checked
    input.disabled = disabled
    input.addEventListener('change', () => onChange(input.checked))
    row.append(this.#el('span', 'switch-label', label), input)
    return row
  }

  #switches(status: Status): HTMLElement {
    const group = this.#el('div', 'switches')
    const { settings } = status
    group.append(
      this.#switch('definitions', 'Show definitions', settings.definitions, on => {
        void this.#act(() => this.#backend.send({ type: 'set-settings', patch: { definitions: on } }))
      }),
      this.#switch('orderByContext', 'Order by context', settings.orderByContext, on => this.#setOrder(on)),
      this.#host
        ? this.#switch('site', `On ${this.#host}`, status.siteEnabled, on => {
          void this.#act(() => this.#backend.send({ type: 'set-site', host: this.#host!, enabled: on }))
        })
        : this.#switch('site', 'Not available on this page', false, () => {}, true),
    )
    return group
  }

  #setOrder(on: boolean): void {
    const model = this.#status!.bundles.model
    if (on && model.phase !== 'ready' && !busyPhase(model)) {
      // The model is missing: the reader sees its size and confirms first.
      this.#consent = true
      this.#render()
      this.#root.querySelector<HTMLElement>('[data-action="confirm-order"]')?.focus()
      return
    }
    this.#consent = false
    void this.#act(() => this.#backend.send({ type: 'set-settings', patch: { orderByContext: on } }))
  }

  #consentBlock(status: Status): HTMLElement {
    const model = status.bundles.model
    const block = this.#el('div', 'consent')
    block.dataset.part = 'consent'
    block.setAttribute('role', 'group')
    block.setAttribute('aria-label', 'Download the context model')
    block.append(this.#el('p', undefined, `Order by context uses a local model. It needs a one-time download of ${formatMegabytes(model.requiredBytes)}. It runs on this computer; nothing you select leaves it.`))
    const actions = this.#el('div', 'actions')
    const confirm = this.#button('Download and turn on', 'consent:confirm', () => {
      this.#consent = false
      void this.#act(async () => {
        await this.#backend.send({ type: 'download', bundle: 'model', acceptBytes: model.requiredBytes })
        return this.#backend.send({ type: 'set-settings', patch: { orderByContext: true } })
      })
    }, { primary: true, ariaLabel: `Download the model, ${formatMegabytes(model.requiredBytes)}, and turn on Order by context` })
    confirm.textContent = 'Download and turn on'
    confirm.dataset.action = 'confirm-order'
    const decline = this.#button('Not now', 'consent:decline', () => { this.#consent = false; this.#render() })
    decline.dataset.action = 'decline-order'
    actions.append(confirm, decline)
    block.append(actions)
    return block
  }

  #bundle(name: BundleName, status: Status): HTMLElement {
    const bundle = status.bundles[name]
    const { title, noun, description } = NAMES[name]
    if (bundle.phase !== 'ready' && this.#confirmRemove === name) this.#confirmRemove = null
    const section = this.#el('section', 'bundle')
    section.dataset.bundle = name
    section.setAttribute('aria-label', title)
    section.append(this.#el('h2', undefined, title), this.#el('p', 'description', description))
    const state = this.#el('p', 'state')
    state.dataset.part = 'state'
    section.append(state)
    const actions = this.#el('div', 'actions')
    const download = (label: string, action: string) => {
      const button = this.#button(label, `${name}:${action}`, () => {
        void this.#act(() => this.#backend.send({ type: 'download', bundle: name, acceptBytes: bundle.requiredBytes }))
      }, { primary: true, ariaLabel: action === 'retry' ? `Retry the ${noun} download, ${formatMegabytes(bundle.requiredBytes)}` : `Download the ${noun}, ${formatMegabytes(bundle.requiredBytes)}` })
      button.dataset.action = action
      return button
    }

    switch (bundle.phase) {
      case 'missing':
        state.textContent = `Needs a one-time download of ${formatMegabytes(bundle.requiredBytes)}.`
        actions.append(download('Download', 'download'))
        break
      case 'downloading': {
        const percent = bundle.totalBytes > 0 ? Math.min(100, Math.floor((100 * bundle.receivedBytes) / bundle.totalBytes)) : 0
        state.textContent = `Downloading ${(bundle.receivedBytes / 1_000_000).toFixed(1)} of ${formatMegabytes(bundle.totalBytes)}…`
        const bar = this.#el('div', 'progress')
        bar.setAttribute('role', 'progressbar')
        bar.setAttribute('aria-label', `${title} download`)
        bar.setAttribute('aria-valuemin', '0')
        bar.setAttribute('aria-valuemax', '100')
        bar.setAttribute('aria-valuenow', String(percent))
        const fill = this.#el('div', 'progress-fill')
        fill.style.width = `${percent}%`
        bar.append(fill)
        section.append(bar)
        const cancel = this.#button('Cancel', `${name}:cancel`, () => {
          void this.#act(() => this.#backend.send({ type: 'cancel-download', bundle: name }))
        }, { ariaLabel: `Cancel the ${noun} download` })
        cancel.dataset.action = 'cancel'
        actions.append(cancel)
        break
      }
      case 'installing':
        state.textContent = 'Checking and installing…'
        break
      case 'ready': {
        state.textContent = `Installed, ${formatMegabytes(bundle.storedBytes)} used`
        if (this.#confirmRemove === name) {
          section.append(this.#removeQuestion(name, bundle))
          break
        }
        const remove = this.#button('Remove', `${name}:remove`, () => {
          this.#confirmRemove = name
          this.#render()
          this.#root.querySelector<HTMLElement>(`[data-bundle="${name}"] [data-action="keep"]`)?.focus()
        }, { ariaLabel: `Remove the downloaded ${noun}` })
        remove.dataset.action = 'remove'
        actions.append(remove)
        break
      }
      case 'failed':
        state.textContent = `Not installed. The download is ${formatMegabytes(bundle.requiredBytes)}.`
        actions.append(download('Retry', 'retry'))
        break
    }
    if (bundle.error && bundle.phase !== 'ready' && !busyPhase(bundle)) {
      const error = this.#el('p', 'error', errorMessage(bundle.error))
      error.dataset.part = 'error'
      error.setAttribute('role', 'alert')
      section.append(error)
    }
    const note = name === 'dictionary' ? this.#dictionaryHint(status) : this.#rankerNote(status)
    if (note) section.append(note)
    if (actions.childElementCount) section.append(actions)
    return section
  }

  /** Removal asks first: the files are large and downloading them again takes time. */
  #removeQuestion(name: BundleName, bundle: BundleStatus): HTMLElement {
    const { noun } = NAMES[name]
    const block = this.#el('div', 'consent')
    block.dataset.part = 'confirm-remove'
    block.setAttribute('role', 'group')
    block.setAttribute('aria-label', `Remove the downloaded ${noun}`)
    block.append(this.#el('p', undefined, `Remove the ${noun}? This frees ${formatMegabytes(bundle.storedBytes)}. You can download it again later.`))
    const actions = this.#el('div', 'actions')
    const confirm = this.#button('Remove', `${name}:confirm-remove`, () => {
      this.#confirmRemove = null
      void this.#act(() => this.#backend.send({ type: 'remove-assets', bundle: name }))
    }, { primary: true, ariaLabel: `Remove the ${noun} now` })
    confirm.dataset.action = 'confirm-remove'
    const keep = this.#button('Keep', `${name}:keep`, () => {
      this.#confirmRemove = null
      this.#render()
      this.#root.querySelector<HTMLElement>(`[data-bundle="${name}"] [data-action="remove"]`)?.focus()
    }, { ariaLabel: `Keep the ${noun}` })
    keep.dataset.action = 'keep'
    actions.append(confirm, keep)
    block.append(actions)
    return block
  }

  #dictionaryHint(status: Status): HTMLElement | null {
    if (!status.settings.definitions || status.bundles.dictionary.phase === 'ready') return null
    const hint = this.#el('p', 'hint', 'Definitions appear once the dictionary is downloaded.')
    hint.dataset.part = 'hint'
    return hint
  }

  #rankerNote(status: Status): HTMLElement | null {
    if (!status.settings.orderByContext) return null
    const model = status.bundles.model
    let text = '', alert = false
    if (model.phase === 'missing' || model.phase === 'failed') text = 'Order by context needs the model. Meanings keep their dictionary order until it is downloaded.'
    else if (model.phase !== 'ready') return null
    else if (status.ranker.state === 'loading') text = 'Starting the model… Meanings keep their dictionary order until it is ready.'
    else if (status.ranker.state === 'failed') { text = `${errorMessage(status.ranker.code)} Meanings keep their dictionary order.`; alert = true }
    else return null
    const note = this.#el('p', alert ? 'note error' : 'note', text)
    note.dataset.part = 'ranker'
    if (alert) note.setAttribute('role', 'alert')
    return note
  }

  #credits(): HTMLElement {
    const footer = this.#el('footer', 'credits')
    footer.dataset.part = 'credits'
    const paragraph = this.#el('p')
    for (const part of CREDITS) {
      if (typeof part === 'string') { paragraph.append(part); continue }
      const link = this.#el('a', undefined, part.text)
      link.href = part.href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      paragraph.append(link)
    }
    footer.append(paragraph)
    return footer
  }
}

const HOSTED = new Set(['status', 'set-settings', 'download', 'cancel-download', 'remove-assets'])

/** `request` naming `host` as the asking page, when it is answered with a Status and names none yet. */
export function withHost<T extends Request>(request: T, host: string | null): T {
  if (!host || !HOSTED.has(request.type) || (request as { host?: string }).host !== undefined) return request
  return { ...request, host }
}

/** The host name of an ordinary web page address, or null for anything else. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname ? parsed.hostname : null
  } catch {
    return null
  }
}
