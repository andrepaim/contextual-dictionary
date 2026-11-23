// The content script: selection, context and the definition card.
// Wiring only; see docs/plan.md section 5.5.
import { createBackend } from './backend'
import { Controller } from './controller'

document.documentElement.dataset.contextualDictionary = 'loaded'

const backend = createBackend(message => chrome.runtime.sendMessage(message))
const controller = new Controller({ backend, host: location.hostname })
void controller.start()

// Settings live in chrome.storage.local; any change there may switch the card on or off.
chrome.storage?.onChanged.addListener((_changes, area) => { if (area === 'local') void controller.refresh() })

// The popup asks the page for its host when the tab's address is not visible to it.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'contextual-dictionary:host') return
  sendResponse({ host: location.hostname })
})
