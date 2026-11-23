// Settings helpers shared by the service worker and the content script: the
// storage key, the per-site switch and the host a page is judged by.
import { normalizeSettings, type Settings } from './contracts'

/** The chrome.storage.local key that holds the Settings. */
export const SETTINGS_KEY = 'settings'

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

/** Whether the extension is active on `host`; a page without a host (a file, a blank frame) counts as enabled. */
export function isSiteEnabled(settings: Pick<Settings, 'disabledSites'>, host: string | undefined): boolean {
  if (!host) return true
  return !settings.disabledSites.includes(normalizeHost(host))
}

export interface LocationLike { hostname: string; ancestorOrigins?: ArrayLike<string> }

/**
 * The host the site switch applies to: the top-level page's, so switching a
 * site off in the popup silences every frame of the tab. A frame whose top
 * origin is opaque or unreadable uses its own host.
 */
export function pageHost(location: LocationLike): string {
  const ancestors = location.ancestorOrigins
  const top = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : undefined
  if (top) {
    try {
      const hostname = new URL(top).hostname
      if (hostname) return normalizeHost(hostname)
    } catch { /* an opaque origin such as "null" */ }
  }
  return normalizeHost(location.hostname)
}

/** What the content script applies after a chrome.storage change, or null when the settings did not change. */
export function activationFromChange(changes: Record<string, { newValue?: unknown }>, area: string, host: string): { settings: Settings; siteEnabled: boolean } | null {
  if (area !== 'local' || !Object.hasOwn(changes, SETTINGS_KEY)) return null
  const settings = normalizeSettings(changes[SETTINGS_KEY]!.newValue as Partial<Settings> | undefined)
  return { settings, siteEnabled: isSiteEnabled(settings, host) }
}
