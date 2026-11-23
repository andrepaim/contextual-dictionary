// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ERROR_MESSAGES, PopupView, formatMegabytes, hostOf, withHost } from '../../../src/popup/popup'
import { CodedError, DEFAULT_SETTINGS, type Answers, type Backend, type BundleName, type BundleStatus, type Request, type Settings, type Status } from '../../../src/shared/contracts'

const MISSING: BundleStatus = { phase: 'missing', error: null, requiredBytes: 123_456_789, receivedBytes: 0, totalBytes: 123_456_789, storedBytes: 0 }
const READY: BundleStatus = { phase: 'ready', error: null, requiredBytes: 0, receivedBytes: 0, totalBytes: 0, storedBytes: 98_700_000 }

function makeStatus(overrides: { settings?: Partial<Settings>; siteEnabled?: boolean; dictionary?: Partial<BundleStatus>; model?: Partial<BundleStatus>; ranker?: Status['ranker'] } = {}): Status {
  return {
    // The popup tests start from ordering off unless they say otherwise.
    settings: { ...DEFAULT_SETTINGS, orderByContext: false, ...overrides.settings },
    siteEnabled: overrides.siteEnabled ?? true,
    bundles: { dictionary: { ...READY, ...overrides.dictionary }, model: { ...MISSING, ...overrides.model } },
    ranker: overrides.ranker ?? { state: 'idle' },
  }
}

/** Answers every request with `current`, or with what `handle` returns. */
class FakeBackend implements Backend {
  requests: Request[] = []
  current: Status = makeStatus()
  handle?: (request: Request) => Promise<unknown> | undefined
  send<T extends Request>(request: T): Promise<Answers[T['type']]> {
    this.requests.push(request)
    const handled = this.handle?.(request)
    if (handled) return handled as Promise<Answers[T['type']]>
    return Promise.resolve(this.current as Answers[T['type']])
  }
  ofType(type: Request['type']) { return this.requests.filter(request => request.type === type) }
}

let backend: FakeBackend
let root: HTMLElement
let view: PopupView | undefined
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }

beforeEach(() => {
  backend = new FakeBackend()
  document.body.innerHTML = '<main id="app"></main>'
  root = document.getElementById('app')!
})

afterEach(() => {
  view?.destroy()
  view = undefined
  vi.useRealTimers()
})

async function open(status: Status, host: string | null = 'example.org') {
  backend.current = status
  view = new PopupView({ root, backend, host })
  await view.start()
  await flush()
}

const control = (name: string) => root.querySelector<HTMLInputElement>(`[data-control="${name}"]`)!
const section = (bundle: BundleName) => root.querySelector<HTMLElement>(`[data-bundle="${bundle}"]`)!
const action = (scope: ParentNode, name: string) => scope.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)
const labelOf = (input: HTMLInputElement) => input.closest('label')!.textContent!.trim()
const toggle = async (name: string) => { control(name).click(); await flush() }

describe('formatMegabytes', () => {
  test('shows megabytes with one decimal', () => {
    expect(formatMegabytes(123_456_789)).toBe('123.5 MB')
    expect(formatMegabytes(400_000)).toBe('0.4 MB')
    expect(formatMegabytes(0)).toBe('0.0 MB')
  })
})

describe('ERROR_MESSAGES', () => {
  test('has a plain-language message for every download, install and model code', () => {
    const codes = ['DOWNLOAD_FAILED', 'DOWNLOAD_STALLED', 'DOWNLOAD_CANCELLED', 'DOWNLOAD_SIZE_CHANGED', 'DOWNLOAD_UNAVAILABLE', 'ASSET_CORRUPT', 'ASSET_MISMATCH', 'DISK_FULL', 'INSTALL_FAILED', 'MODEL_MISMATCH', 'RUNTIME_FAILED', 'SESSION_FAILED', 'LOAD_TIMEOUT', 'WORKER_ERROR']
    for (const code of codes) {
      expect(ERROR_MESSAGES[code], code).toMatch(/^[A-Z].+\.$/)
      expect(ERROR_MESSAGES[code], code).not.toContain('_')
    }
    expect(new Set(codes.map(code => ERROR_MESSAGES[code])).size).toBeGreaterThan(10)
  })
})

describe('PopupView switches', () => {
  test('asks for the status of the active tab host and shows the settings', async () => {
    await open(makeStatus({ settings: { definitions: true, orderByContext: false } }))
    expect(backend.requests[0]).toEqual({ type: 'status', host: 'example.org' })
    expect(control('definitions').checked).toBe(true)
    expect(control('orderByContext').checked).toBe(false)
    expect(control('site').checked).toBe(true)
    expect(labelOf(control('definitions'))).toBe('Show definitions')
    expect(labelOf(control('orderByContext'))).toBe('Order by context')
    expect(labelOf(control('site'))).toBe('On example.org')
    for (const name of ['definitions', 'orderByContext', 'site']) expect(control(name).getAttribute('role')).toBe('switch')
  })

  test('"Show definitions" sends the setting', async () => {
    await open(makeStatus())
    backend.current = makeStatus({ settings: { definitions: false } })
    await toggle('definitions')
    expect(backend.ofType('set-settings')).toEqual([{ type: 'set-settings', patch: { definitions: false } }])
    expect(control('definitions').checked).toBe(false)
  })

  test('the site switch turns the extension off and on for the host', async () => {
    await open(makeStatus())
    backend.current = makeStatus({ siteEnabled: false })
    await toggle('site')
    expect(backend.ofType('set-site')).toEqual([{ type: 'set-site', host: 'example.org', enabled: false }])
    expect(control('site').checked).toBe(false)
    backend.current = makeStatus()
    await toggle('site')
    expect(backend.ofType('set-site')[1]).toEqual({ type: 'set-site', host: 'example.org', enabled: true })
  })

  test('without a web page host the site switch is disabled', async () => {
    await open(makeStatus(), null)
    expect(backend.requests[0]).toEqual({ type: 'status' })
    expect(control('site').disabled).toBe(true)
    expect(labelOf(control('site'))).toBe('Not available on this page')
  })

  test('"Order by context" with the model installed turns on at once, and off', async () => {
    await open(makeStatus({ model: READY }))
    backend.current = makeStatus({ model: READY, settings: { orderByContext: true } })
    await toggle('orderByContext')
    expect(backend.ofType('set-settings')).toEqual([{ type: 'set-settings', patch: { orderByContext: true } }])
    expect(control('orderByContext').checked).toBe(true)
    backend.current = makeStatus({ model: READY })
    await toggle('orderByContext')
    expect(backend.ofType('set-settings')[1]).toEqual({ type: 'set-settings', patch: { orderByContext: false } })
  })

  test('"Order by context" without the model asks for consent to the exact download first', async () => {
    await open(makeStatus())
    await toggle('orderByContext')
    expect(backend.requests.filter(request => request.type !== 'status')).toEqual([])
    expect(control('orderByContext').checked).toBe(false)
    const consent = root.querySelector<HTMLElement>('[data-part="consent"]')!
    expect(consent.getAttribute('role')).toBe('group')
    expect(consent.textContent).toContain('123.5 MB')
    expect(action(consent, 'confirm-order')!.textContent).toBe('Download and turn on')
    backend.current = makeStatus({ model: { phase: 'downloading', receivedBytes: 0 }, settings: { orderByContext: true } })
    action(consent, 'confirm-order')!.click()
    await flush()
    expect(backend.requests.filter(request => request.type !== 'status')).toEqual([
      { type: 'download', bundle: 'model', acceptBytes: 123_456_789 },
      { type: 'set-settings', patch: { orderByContext: true } },
    ])
    expect(root.querySelector('[data-part="consent"]')).toBeNull()
    expect(control('orderByContext').checked).toBe(true)
  })

  test('"Not now" closes the consent without downloading', async () => {
    await open(makeStatus())
    await toggle('orderByContext')
    action(root, 'decline-order')!.click()
    await flush()
    expect(root.querySelector('[data-part="consent"]')).toBeNull()
    expect(backend.ofType('download')).toEqual([])
    expect(control('orderByContext').checked).toBe(false)
  })

  test('"Order by context" during a model download turns on without a second download', async () => {
    await open(makeStatus({ model: { phase: 'downloading', receivedBytes: 1 } }))
    await toggle('orderByContext')
    expect(backend.ofType('download')).toEqual([])
    expect(backend.ofType('set-settings')).toEqual([{ type: 'set-settings', patch: { orderByContext: true } }])
  })

  test('a failed setting change shows a message and the switch returns to the saved state', async () => {
    await open(makeStatus())
    backend.handle = request => request.type === 'set-settings' ? Promise.reject(new CodedError('NO_RESPONSE')) : undefined
    await toggle('definitions')
    expect(root.querySelector('[data-part="problem"]')!.textContent).toContain('not responding')
    expect(control('definitions').checked).toBe(true)
  })
})

describe.each(['dictionary', 'model'] as const)('PopupView %s bundle', bundle => {
  const statusWith = (state: Partial<BundleStatus>) => makeStatus({ [bundle]: { ...MISSING, ...state } })

  test('missing: shows the exact size and a Download button that accepts it', async () => {
    await open(statusWith({}))
    const scope = section(bundle)
    expect(scope.querySelector('[data-part="state"]')!.textContent).toContain('123.5 MB')
    const download = action(scope, 'download')!
    expect(download.textContent).toBe('Download')
    expect(download.getAttribute('aria-label')).toMatch(/^Download the (dictionary|model), 123\.5 MB$/)
    download.click()
    await flush()
    expect(backend.ofType('download')).toEqual([{ type: 'download', bundle, acceptBytes: 123_456_789 }])
  })

  test('downloading: shows progress and Cancel', async () => {
    await open(statusWith({ phase: 'downloading', receivedBytes: 30_864_200 }))
    const scope = section(bundle)
    const bar = scope.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-label')).toBeTruthy()
    expect(scope.querySelector('[data-part="state"]')!.textContent).toBe('Downloading 30.9 of 123.5 MB…')
    action(scope, 'cancel')!.click()
    await flush()
    expect(backend.ofType('cancel-download')).toEqual([{ type: 'cancel-download', bundle }])
  })

  test('downloading with an unknown total shows an empty bar', async () => {
    await open(statusWith({ phase: 'downloading', receivedBytes: 10, totalBytes: 0 }))
    expect(section(bundle).querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('0')
  })

  test('installing: says it is checking and installing', async () => {
    await open(statusWith({ phase: 'installing' }))
    const scope = section(bundle)
    expect(scope.querySelector('[data-part="state"]')!.textContent).toBe('Checking and installing…')
    expect(scope.querySelectorAll('button')).toHaveLength(0)
  })

  test('ready: shows the storage used and Remove', async () => {
    await open(makeStatus({ [bundle]: READY }))
    const scope = section(bundle)
    expect(scope.querySelector('[data-part="state"]')!.textContent).toBe('Installed, 98.7 MB used')
    expect(action(scope, 'remove')!.getAttribute('aria-label')).toMatch(/^Remove the downloaded (dictionary|model)$/)
    action(scope, 'remove')!.click()
    await flush()
    // Removal asks first; nothing is removed until the reader confirms.
    expect(backend.ofType('remove-assets')).toEqual([])
    const confirm = section(bundle).querySelector<HTMLElement>('[data-part="confirm-remove"]')!
    expect(confirm.textContent).toContain('98.7 MB')
    expect(confirm.getAttribute('role')).toBe('group')
    expect(root.ownerDocument.activeElement).toBe(action(section(bundle), 'keep'))
    action(section(bundle), 'confirm-remove')!.click()
    await flush()
    expect(backend.ofType('remove-assets')).toEqual([{ type: 'remove-assets', bundle }])
  })

  test('ready: "Keep" closes the removal question without removing anything', async () => {
    await open(makeStatus({ [bundle]: READY }))
    action(section(bundle), 'remove')!.click()
    await flush()
    action(section(bundle), 'keep')!.click()
    await flush()
    expect(section(bundle).querySelector('[data-part="confirm-remove"]')).toBeNull()
    expect(action(section(bundle), 'remove')).not.toBeNull()
    expect(backend.ofType('remove-assets')).toEqual([])
  })

  test('ready: the removal question goes away when the bundle stops being installed', async () => {
    await open(makeStatus({ [bundle]: READY }))
    action(section(bundle), 'remove')!.click()
    await flush()
    backend.current = statusWith({})
    control('definitions').click()
    await flush()
    expect(section(bundle).querySelector('[data-part="confirm-remove"]')).toBeNull()
  })

  test.each(['DOWNLOAD_FAILED', 'DOWNLOAD_STALLED', 'DOWNLOAD_CANCELLED', 'DOWNLOAD_SIZE_CHANGED', 'DOWNLOAD_UNAVAILABLE', 'ASSET_CORRUPT', 'ASSET_MISMATCH', 'DISK_FULL', 'INSTALL_FAILED'])('failed with %s: a readable message and Retry', async code => {
    await open(statusWith({ phase: 'failed', error: code, requiredBytes: 100_000_000 }))
    const scope = section(bundle)
    const message = scope.querySelector('[data-part="error"]')!
    expect(message.textContent).toBe(ERROR_MESSAGES[code])
    expect(message.getAttribute('role')).toBe('alert')
    action(scope, 'retry')!.click()
    await flush()
    expect(backend.ofType('download')).toEqual([{ type: 'download', bundle, acceptBytes: 100_000_000 }])
  })

  test('failed with an unknown code still says something readable', async () => {
    await open(statusWith({ phase: 'failed', error: 'WEIRD_THING' }))
    expect(section(bundle).querySelector('[data-part="error"]')!.textContent).toBe('Something went wrong (WEIRD_THING). Try again.')
  })

  test('missing after a cancelled download says so and offers the download again', async () => {
    await open(statusWith({ error: 'DOWNLOAD_CANCELLED' }))
    const scope = section(bundle)
    expect(scope.querySelector('[data-part="error"]')!.textContent).toBe(ERROR_MESSAGES.DOWNLOAD_CANCELLED)
    expect(action(scope, 'download')).not.toBeNull()
  })
})

describe('PopupView actions', () => {
  test('a refused download shows the reason and the new size', async () => {
    await open(makeStatus())
    backend.handle = request => {
      if (request.type !== 'download') return undefined
      backend.current = makeStatus({ model: { requiredBytes: 130_000_000 } })
      return Promise.reject(new CodedError('DOWNLOAD_SIZE_CHANGED'))
    }
    action(section('model'), 'download')!.click()
    await flush()
    expect(root.querySelector('[data-part="problem"]')!.textContent).toBe(ERROR_MESSAGES.DOWNLOAD_SIZE_CHANGED)
    expect(section('model').querySelector('[data-part="state"]')!.textContent).toContain('130.0 MB')
  })

  test('controls are disabled while an action is in flight', async () => {
    await open(makeStatus())
    let release!: (value: Status) => void
    backend.handle = request => request.type === 'download' ? new Promise(resolve => { release = resolve }) : undefined
    action(section('model'), 'download')!.click()
    await flush()
    expect([...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')].every(element => element.disabled)).toBe(true)
    release(makeStatus())
    await flush()
    expect(control('definitions').disabled).toBe(false)
  })

  test('a status that cannot be read says the extension is not responding', async () => {
    backend.handle = () => Promise.reject(new CodedError('NO_RESPONSE'))
    view = new PopupView({ root, backend, host: 'example.org' })
    await view.start()
    expect(root.querySelector('[data-part="problem"]')!.textContent).toBe(ERROR_MESSAGES.NO_RESPONSE)
  })
})

describe('PopupView model status', () => {
  test('a starting model is mentioned while ordering is on', async () => {
    await open(makeStatus({ model: READY, settings: { orderByContext: true }, ranker: { state: 'loading' } }))
    expect(section('model').querySelector('[data-part="ranker"]')!.textContent).toBe('Starting the model… Meanings keep their dictionary order until it is ready.')
  })

  test.each(['MODEL_MISMATCH', 'RUNTIME_FAILED', 'SESSION_FAILED', 'LOAD_TIMEOUT', 'WORKER_ERROR'])('a model failure %s is explained', async code => {
    await open(makeStatus({ model: READY, settings: { orderByContext: true }, ranker: { state: 'failed', code } }))
    const message = section('model').querySelector('[data-part="ranker"]')!
    expect(message.textContent).toBe(`${ERROR_MESSAGES[code]} Meanings keep their dictionary order.`)
    expect(message.getAttribute('role')).toBe('alert')
  })

  test('nothing about the model runtime while ordering is off', async () => {
    await open(makeStatus({ model: READY, ranker: { state: 'failed', code: 'WORKER_ERROR' } }))
    expect(section('model').querySelector('[data-part="ranker"]')).toBeNull()
  })

  test('ordering on without the model offers the download', async () => {
    await open(makeStatus({ settings: { orderByContext: true } }))
    expect(section('model').querySelector('[data-part="ranker"]')!.textContent).toBe('Order by context needs the model. Meanings keep their dictionary order until it is downloaded.')
  })

  test('the dictionary is needed for definitions', async () => {
    await open(makeStatus({ dictionary: MISSING }))
    expect(section('dictionary').querySelector('[data-part="hint"]')!.textContent).toBe('Definitions appear once the dictionary is downloaded.')
  })
})

describe('PopupView polling', () => {
  test('polls every 500 ms while a download runs and stops when it settles', async () => {
    vi.useFakeTimers()
    await open(makeStatus({ dictionary: { ...MISSING, phase: 'downloading', receivedBytes: 1 } }))
    const polls = () => backend.ofType('status').length
    expect(polls()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(polls()).toBe(2)
    backend.current = makeStatus({ dictionary: { ...MISSING, phase: 'installing' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(polls()).toBe(3)
    expect(section('dictionary').querySelector('[data-part="state"]')!.textContent).toBe('Checking and installing…')
    backend.current = makeStatus()
    await vi.advanceTimersByTimeAsync(500)
    expect(polls()).toBe(4)
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(4)
  })

  test('polls while the model loads', async () => {
    vi.useFakeTimers()
    await open(makeStatus({ model: READY, settings: { orderByContext: true }, ranker: { state: 'loading' } }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.ofType('status').length).toBe(3)
  })

  test('starts polling after a download starts and stops on destroy', async () => {
    vi.useFakeTimers()
    await open(makeStatus())
    backend.current = makeStatus({ model: { phase: 'downloading', receivedBytes: 1 } })
    action(section('model'), 'download')!.click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(backend.ofType('status').length).toBe(3)
    view!.destroy()
    await vi.advanceTimersByTimeAsync(5000)
    expect(backend.ofType('status').length).toBe(3)
  })

  test('keeps keyboard focus on the same control across updates', async () => {
    vi.useFakeTimers()
    await open(makeStatus({ model: { phase: 'downloading', receivedBytes: 1 } }))
    action(section('model'), 'cancel')!.focus()
    backend.current = makeStatus({ model: { phase: 'downloading', receivedBytes: 50_000_000 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(document.activeElement).toBe(action(section('model'), 'cancel'))
    expect(section('model').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('40')
  })
})

describe('PopupView accessibility and credits', () => {
  test('every control has an accessible name', async () => {
    await open(makeStatus({ model: { phase: 'downloading', receivedBytes: 1 } }))
    const controls = [...root.querySelectorAll<HTMLElement>('button, input, a')]
    expect(controls.length).toBeGreaterThan(5)
    for (const element of controls) {
      const name = element.getAttribute('aria-label') ?? element.closest('label')?.textContent ?? element.textContent
      expect(name?.trim(), element.outerHTML).toBeTruthy()
    }
  })

  test('shows the dictionary and model attribution and licences', async () => {
    await open(makeStatus())
    const credits = root.querySelector('[data-part="credits"]')!.textContent!
    for (const text of ['Wiktionary', 'CC BY-SA 4.0', 'Ettin-150m-WSD', 'Apache-2.0', 'ONNX Runtime', 'MIT']) expect(credits).toContain(text)
    for (const link of root.querySelectorAll<HTMLAnchorElement>('[data-part="credits"] a')) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\//)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })
})

describe('withHost', () => {
  test('adds the active tab host to every request answered with a status', () => {
    expect(withHost({ type: 'status' }, 'a.org')).toEqual({ type: 'status', host: 'a.org' })
    expect(withHost({ type: 'set-settings', patch: { definitions: false } }, 'a.org')).toEqual({ type: 'set-settings', patch: { definitions: false }, host: 'a.org' })
    expect(withHost({ type: 'download', bundle: 'model', acceptBytes: 5 }, 'a.org')).toEqual({ type: 'download', bundle: 'model', acceptBytes: 5, host: 'a.org' })
    expect(withHost({ type: 'cancel-download', bundle: 'model' }, 'a.org')).toEqual({ type: 'cancel-download', bundle: 'model', host: 'a.org' })
    expect(withHost({ type: 'remove-assets', bundle: 'model' }, 'a.org')).toEqual({ type: 'remove-assets', bundle: 'model', host: 'a.org' })
  })
  test('keeps a host the request already names, and leaves other requests alone', () => {
    expect(withHost({ type: 'set-site', host: 'b.org', enabled: false }, 'a.org')).toEqual({ type: 'set-site', host: 'b.org', enabled: false })
    expect(withHost({ type: 'status', host: 'b.org' }, 'a.org')).toEqual({ type: 'status', host: 'b.org' })
    expect(withHost({ type: 'cancel-define', requestId: 'x' }, 'a.org')).toEqual({ type: 'cancel-define', requestId: 'x' })
  })
  test('without a host nothing is added', () => {
    expect(withHost({ type: 'download', bundle: 'model', acceptBytes: 5 }, null)).toEqual({ type: 'download', bundle: 'model', acceptBytes: 5 })
  })
})

describe('hostOf', () => {
  test('is the host of http and https pages only', () => {
    expect(hostOf('https://en.wikipedia.org/wiki/Mouse')).toBe('en.wikipedia.org')
    expect(hostOf('http://127.0.0.1:8080/a.html')).toBe('127.0.0.1')
    for (const url of [undefined, '', 'chrome://extensions', 'file:///tmp/a.html', 'about:blank', 'not a url', 'chrome-extension://abc/popup.html'])
      expect(hostOf(url), String(url)).toBeNull()
  })
})
