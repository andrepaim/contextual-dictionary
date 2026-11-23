// The content script: selection, context and the definition card.
// Wiring only; see docs/plan.md section 5.5.
import { activationFromChange, pageHost } from '../shared/settings'
import { createBackend } from './backend'
import { Controller } from './controller'

document.documentElement.dataset.contextualDictionary = 'loaded'

// A frame is judged by its tab's top-level site, like the popup's site switch.
const host = pageHost(location)
const backend = createBackend(message => chrome.runtime.sendMessage(message))
const controller = new Controller({ backend, host })
void controller.start()

// A settings change switches the card on or off at once, without asking the back end.
chrome.storage?.onChanged.addListener((changes, area) => {
  const state = activationFromChange(changes, area, host)
  if (state) controller.apply(state)
})

// The popup asks the page for its host when the tab's address is not visible to it.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if ((message as { type?: unknown } | null)?.type !== 'contextual-dictionary:host') return
  sendResponse({ host })
})
