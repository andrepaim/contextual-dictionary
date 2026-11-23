// What the service worker sends the offscreen document. Each message carries
// the current settings, because the offscreen document cannot read
// chrome.storage (its only extension API is chrome.runtime) and may have been
// recreated since the last change.
import { isRequest, type BundleName, type BundleStatus, type RankerStatus, type Request, type Settings } from './contracts'

export const OFFSCREEN_TARGET = 'contextual-dictionary:offscreen'

export type OffscreenRequest =
  | Extract<Request, { type: 'define' | 'cancel-define' | 'download' | 'cancel-download' | 'remove-assets' }>
  | { type: 'status' }
  /** Apply the settings now, for example to start or stop the model. */
  | { type: 'settings' }

export interface OffscreenMessage { target: typeof OFFSCREEN_TARGET; request: OffscreenRequest; settings: Settings }

/** The part of a Status only the offscreen document knows. */
export interface RuntimeStatus { bundles: Record<BundleName, BundleStatus>; ranker: RankerStatus }

export const offscreenMessage = (request: OffscreenRequest, settings: Settings): OffscreenMessage => ({ target: OFFSCREEN_TARGET, request, settings })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const FORWARDED = new Set(['define', 'cancel-define', 'download', 'cancel-download', 'remove-assets', 'status'])

export function isOffscreenMessage(value: unknown): value is OffscreenMessage {
  if (!isRecord(value) || value.target !== OFFSCREEN_TARGET || !isRecord(value.settings) || !isRecord(value.request)) return false
  const request = value.request
  if (request.type === 'settings') return true
  return FORWARDED.has(request.type as string) && isRequest(request)
}

const PHASES = new Set(['missing', 'downloading', 'installing', 'ready', 'failed'])
const RANKER_STATES = new Set(['idle', 'loading', 'ready', 'failed', 'closed'])
const isBundle = (value: unknown) => isRecord(value) && PHASES.has(value.phase as string)
  && ['requiredBytes', 'receivedBytes', 'totalBytes', 'storedBytes'].every(key => typeof value[key] === 'number')
  && (value.error === null || typeof value.error === 'string')

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value) || !isRecord(value.bundles) || !isRecord(value.ranker)) return false
  return isBundle(value.bundles.dictionary) && isBundle(value.bundles.model) && RANKER_STATES.has(value.ranker.state as string)
}
