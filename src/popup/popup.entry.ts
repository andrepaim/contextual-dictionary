// The toolbar popup: switches, download consent and progress. Wiring only;
// see docs/plan.md section 5.5.
import { createBackend } from '../content/backend'
import { PopupView, hostOf, withHost } from './popup'

async function activeHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const host = hostOf(tab?.url ?? tab?.pendingUrl)
  if (host || tab?.id === undefined || tab.url) return host
  // Without the tabs permission the address may be hidden; the page's content script knows it.
  try {
    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'contextual-dictionary:host' }, { frameId: 0 }) as { host?: unknown } | undefined
    return typeof reply?.host === 'string' && reply.host ? reply.host : null
  } catch {
    return null
  }
}

const host = await activeHost().catch(() => null)
const view = new PopupView({
  root: document.getElementById('app')!,
  // Every answer's site switch is then for the active tab.
  backend: createBackend(message => chrome.runtime.sendMessage(withHost(message, host))),
  host,
})
void view.start()
addEventListener('pagehide', () => view.destroy())
