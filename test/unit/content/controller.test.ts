// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Controller } from '../../../src/content/controller'
import { CodedError, DEFAULT_SETTINGS, type Answers, type Backend, type DefineAnswer, type Request, type Settings, type Status } from '../../../src/shared/contracts'

const SOURCE = { name: 'Wiktionary', license: 'CC BY-SA 4.0', url: 'https://en.wiktionary.org/wiki/mouse' }
const bundle = { phase: 'ready' as const, error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 1 }

function status(settings: Partial<Settings> = {}, siteEnabled = true): Status {
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, siteEnabled, bundles: { dictionary: bundle, model: bundle }, ranker: { state: 'idle' } }
}

function answer(query: string, definitions = ['first meaning', 'second meaning']): DefineAnswer {
  return { result: { query, entries: [{ lemma: query, partOfSpeech: 'noun', senses: definitions.map(definition => ({ definition, examples: [] })) }], source: SOURCE }, ordered: false }
}

interface Pending { request: Request; signal?: AbortSignal; resolve(value: unknown): void; reject(error: unknown): void }

/** A back end whose define answers are released by the test. */
class FakeBackend implements Backend {
  requests: Request[] = []
  pending: Pending[] = []
  status: Status | Error = status()
  send<T extends Request>(request: T, signal?: AbortSignal): Promise<Answers[T['type']]> {
    this.requests.push(request)
    if (request.type === 'status') return this.status instanceof Error ? Promise.reject(this.status) : Promise.resolve(this.status as Answers[T['type']])
    if (request.type === 'cancel-define') return Promise.resolve(null as Answers[T['type']])
    return new Promise((resolve, reject) => {
      this.pending.push({ request, signal, resolve: resolve as (value: unknown) => void, reject })
      signal?.addEventListener('abort', () => reject(new CodedError('ABORTED')))
    })
  }
  defines() { return this.requests.filter(request => request.type === 'define') as Extract<Request, { type: 'define' }>[] }
  cancels() { return this.requests.filter(request => request.type === 'cancel-define') }
}

let backend: FakeBackend
let controller: Controller
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = `
    <p id="mouse">Drag the mouse to move the cursor on screen.</p>
    <p id="bank">We walked along the bank of the river.</p>
    <p id="long">one two three four five six seven eight</p>
    <div contenteditable="true" id="editable">mouse in editable text</div>`
  backend = new FakeBackend()
  let next = 0
  controller = new Controller({ backend, host: 'example.org', window, requestId: () => `r${++next}` })
})

afterEach(() => {
  controller.stop()
  vi.useRealTimers()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

function select(id: string, word: string) {
  const node = document.getElementById(id)!.firstChild as Text
  const index = node.data.indexOf(word)
  const range = document.createRange()
  range.setStart(node, index)
  range.setEnd(node, index + word.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return node
}

function mouse(type: 'mousedown' | 'mouseup' | 'dblclick', target: EventTarget = document.body) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, button: 0 }))
}

/** A double-click on a word: the browser selects it at the second mousedown. */
async function doubleClick(id: string, word: string) {
  const target = document.getElementById(id)!
  mouse('mousedown', target)
  window.getSelection()!.removeAllRanges()
  mouse('mouseup', target)
  await vi.advanceTimersByTimeAsync(20)
  mouse('mousedown', target)
  select(id, word)
  mouse('mouseup', target)
  mouse('dblclick', target)
  await vi.advanceTimersByTimeAsync(20)
}

const cardRoot = () => document.querySelector('contextual-dictionary-card')?.shadowRoot ?? null
const cardState = () => {
  const root = cardRoot()
  if (!root || (root.host as HTMLElement).style.getPropertyValue('display') === 'none') return 'hidden'
  return root.querySelector('[role="dialog"]') ? 'card' : root.querySelector('[data-part="placeholder"]') ? 'placeholder' : 'hidden'
}
const definitions = () => [...cardRoot()!.querySelectorAll('[data-part="definition"]')].map(node => node.textContent)

describe('Controller', () => {
  test('asks for the status of its host on start', async () => {
    await controller.start()
    expect(backend.requests[0]).toEqual({ type: 'status', host: 'example.org' })
    expect(controller.active).toBe(true)
  })

  test('a double-click sends one lookup with the selection and its context, shows the placeholder, then the card', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    expect(backend.defines()).toEqual([{ type: 'define', requestId: 'r1', selection: { text: 'mouse', before: 'Drag the ', after: ' to move the cursor on screen.' } }])
    expect(cardState()).toBe('placeholder')
    backend.pending[0]!.resolve(answer('mouse'))
    await flush()
    expect(cardState()).toBe('card')
    expect(definitions()).toEqual(['first meaning', 'second meaning'])
  })

  test('a keyboard selection is looked up once it settles', async () => {
    await controller.start()
    select('mouse', 'mou')
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(100)
    select('mouse', 'mouse')
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(100)
    expect(backend.defines()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(backend.defines().map(request => request.selection.text)).toEqual(['mouse'])
  })

  test('selection changes while the mouse button is down wait for mouseup, and do not repeat it', async () => {
    await controller.start()
    const target = document.getElementById('mouse')!
    mouse('mousedown', target)
    select('mouse', 'mouse')
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.defines()).toHaveLength(0)
    mouse('mouseup', target)
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.defines()).toHaveLength(1)
  })

  test('a new selection cancels the lookup in flight and its late answer is dropped', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    const first = backend.pending[0]!
    await doubleClick('bank', 'bank')
    expect(first.signal!.aborted).toBe(true)
    expect(backend.cancels()).toEqual([{ type: 'cancel-define', requestId: 'r1' }])
    expect(backend.defines().map(request => request.requestId)).toEqual(['r1', 'r2'])
    first.resolve(answer('mouse', ['late']))
    await flush()
    expect(cardState()).toBe('placeholder')
    backend.pending[1]!.resolve(answer('bank', ['river side']))
    await flush()
    expect(definitions()).toEqual(['river side'])
  })

  test('a shown card is never re-rendered by a repeated answer', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.resolve(answer('mouse', ['one', 'two']))
    await flush()
    // The same selection again (selectionchange, dblclick) keeps the card as it is.
    document.dispatchEvent(new Event('selectionchange'))
    mouse('dblclick', document.getElementById('mouse')!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.defines()).toHaveLength(1)
    expect(definitions()).toEqual(['one', 'two'])
  })

  test('a selection that is not definable cancels the lookup and shows nothing', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    const target = document.getElementById('long')!
    mouse('mousedown', target)
    select('long', 'one two three four five six')
    mouse('mouseup', target)
    await vi.advanceTimersByTimeAsync(20)
    expect(backend.pending[0]!.signal!.aborted).toBe(true)
    expect(backend.defines()).toHaveLength(1)
    expect(cardState()).toBe('hidden')
  })

  test('a word selected inside an open shadow root is looked up with its context', async () => {
    await controller.start()
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Inside a shadow tree the <b>cursor</b> blinks.</p>'
    const word = shadow.querySelector('b')!
    const range = document.createRange()
    range.selectNodeContents(word)
    // Chromium exposes such a selection on the shadow root, not on the document.
    Object.assign(shadow, { getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }) })
    window.getSelection()!.removeAllRanges()
    mouse('mousedown', word)
    const up = new MouseEvent('mouseup', { bubbles: true, composed: true })
    word.dispatchEvent(up)
    // As in browsers, an event's path is empty once its dispatch is over.
    Object.assign(up, { composedPath: () => [] })
    await vi.advanceTimersByTimeAsync(20)
    expect(backend.defines().map(request => request.selection)).toEqual([{ text: 'cursor', before: 'Inside a shadow tree the ', after: ' blinks.' }])
  })

  test('selections in editable regions are ignored', async () => {
    await controller.start()
    await doubleClick('editable', 'mouse')
    expect(backend.defines()).toHaveLength(0)
    expect(cardState()).toBe('hidden')
  })

  test('Escape and a click outside dismiss the placeholder and cancel the lookup', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cardState()).toBe('hidden')
    expect(backend.cancels()).toEqual([{ type: 'cancel-define', requestId: 'r1' }])
    backend.pending[0]!.resolve(answer('mouse'))
    await flush()
    expect(cardState()).toBe('hidden')

    await doubleClick('bank', 'bank')
    backend.pending[1]!.resolve(answer('bank'))
    await flush()
    expect(cardState()).toBe('card')
    mouse('mousedown', document.getElementById('mouse')!)
    expect(cardState()).toBe('hidden')
    expect(backend.cancels()).toHaveLength(1)
  })

  test('after a dismissal the same word can be looked up again', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.resolve(answer('mouse'))
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await doubleClick('mouse', 'mouse')
    expect(backend.defines()).toHaveLength(2)
  })

  test('clicks inside the card are not new selections', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.resolve(answer('mouse', ['a', 'b', 'c', 'd']))
    await flush()
    const toggle = cardRoot()!.querySelector<HTMLElement>('[data-part="toggle"]')!
    mouse('mousedown', toggle)
    mouse('mouseup', toggle)
    toggle.click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(cardState()).toBe('card')
    expect(definitions()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('errors and empty results remove the placeholder silently', async () => {
    const errors = vi.spyOn(console, 'error')
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.reject(new CodedError('DICTIONARY_MISSING'))
    await flush()
    expect(cardState()).toBe('hidden')
    await doubleClick('bank', 'bank')
    backend.pending[1]!.resolve({ result: { query: 'bank', entries: [], source: SOURCE }, ordered: false })
    await flush()
    expect(cardState()).toBe('hidden')
    expect(errors).not.toHaveBeenCalled()
  })

  test('the two clicks of a double-click on an unknown word still send one lookup', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.resolve({ result: { query: 'mouse', entries: [], source: SOURCE }, ordered: false })
    await flush()
    mouse('dblclick', document.getElementById('mouse')!)
    await vi.advanceTimersByTimeAsync(20)
    expect(backend.defines()).toHaveLength(1)
  })

  test('stays inert when definitions are off', async () => {
    backend.status = status({ definitions: false })
    await controller.start()
    expect(controller.active).toBe(false)
    await doubleClick('mouse', 'mouse')
    document.dispatchEvent(new Event('selectionchange'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.defines()).toHaveLength(0)
    expect(document.querySelector('contextual-dictionary-card')).toBeNull()
  })

  test('stays inert when the site is switched off', async () => {
    backend.status = status({ disabledSites: ['example.org'] }, false)
    await controller.start()
    await doubleClick('mouse', 'mouse')
    expect(backend.defines()).toHaveLength(0)
  })

  test('stays inert when the back end cannot be reached', async () => {
    backend.status = new CodedError('NO_RESPONSE')
    await controller.start()
    expect(controller.active).toBe(false)
    await doubleClick('mouse', 'mouse')
    expect(backend.defines()).toHaveLength(0)
  })

  test('apply switches it on and off as settings change', async () => {
    backend.status = status({ definitions: false })
    await controller.start()
    controller.apply(status())
    expect(controller.active).toBe(true)
    await doubleClick('mouse', 'mouse')
    expect(backend.defines()).toHaveLength(1)
    controller.apply(status({}, false))
    expect(controller.active).toBe(false)
    expect(backend.cancels()).toHaveLength(1)
    expect(cardState()).toBe('hidden')
    await doubleClick('bank', 'bank')
    expect(backend.defines()).toHaveLength(1)
  })

  test('refresh asks for the status again and applies it', async () => {
    await controller.start()
    backend.status = status({ definitions: false })
    await controller.refresh()
    expect(controller.active).toBe(false)
    expect(backend.requests.filter(request => request.type === 'status')).toHaveLength(2)
  })

  test('an invalidated extension context makes it stop for good', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    backend.pending[0]!.reject(new CodedError('CONTEXT_INVALIDATED'))
    await flush()
    expect(controller.active).toBe(false)
    controller.apply(status())
    expect(controller.active).toBe(false)
  })

  test('cleans up on pagehide and comes back from the back/forward cache', async () => {
    await controller.start()
    await doubleClick('mouse', 'mouse')
    window.dispatchEvent(new Event('pagehide'))
    expect(controller.active).toBe(false)
    expect(backend.cancels()).toHaveLength(1)
    expect(document.querySelector('contextual-dictionary-card')).toBeNull()
    await doubleClick('bank', 'bank')
    expect(backend.defines()).toHaveLength(1)
    const pageshow = new Event('pageshow') as Event & { persisted: boolean }
    Object.defineProperty(pageshow, 'persisted', { value: true })
    window.dispatchEvent(pageshow)
    await flush()
    expect(controller.active).toBe(true)
    await doubleClick('bank', 'bank')
    expect(backend.defines()).toHaveLength(2)
  })

  test('does no work on mouseup when nothing is selected', async () => {
    await controller.start()
    const spy = vi.spyOn(window, 'getComputedStyle')
    mouse('mousedown')
    mouse('mouseup')
    await vi.advanceTimersByTimeAsync(1000)
    expect(spy).not.toHaveBeenCalled()
    expect(backend.defines()).toHaveLength(0)
  })

  test('stop is final', async () => {
    await controller.start()
    controller.stop()
    await controller.refresh()
    expect(controller.active).toBe(false)
  })
})
