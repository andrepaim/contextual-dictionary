// What the card says about the order of the meanings when "Show order
// details" is on (docs/order-details-plan.md): positions, never scores. The
// details come from the back end and are checked against the result here;
// details that do not fit it are not shown at all.
import { ORDER_STATUSES, type DictionaryResult, type OrderDetails, type OrderStatus } from '../shared/contracts'

export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  'ordered': 'Ordered by context',
  'off': 'Dictionary order · ordering is off',
  'no-model': 'Dictionary order · context model not installed',
  'loading': 'Dictionary order · model still loading',
  'timed-out': 'Dictionary order · model took too long, try again',
  'nothing-to-order': 'Dictionary order · nothing to reorder',
  'not-english': 'Dictionary order · text does not look English',
  'none-fits': 'Dictionary order · the model found no fitting meaning',
  'unavailable': 'Dictionary order · ordering unavailable',
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, … */
export function ordinal(n: number): string {
  const tens = n % 100, units = n % 10
  const suffix = tens >= 11 && tens <= 13 ? 'th' : units === 1 ? 'st' : units === 2 ? 'nd' : units === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** The card's status line for usable details. */
export function orderStatusText(details: OrderDetails): string {
  const moved = details.positions?.some(entry => entry.some((position, place) => position !== place))
  return details.status === 'ordered' && !moved ? `${ORDER_STATUS_TEXT.ordered} · same as dictionary order` : ORDER_STATUS_TEXT[details.status]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max

/** Whether `value` holds every place 0 … length − 1 once. */
function isPermutation(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false
  const seen = new Set<number>()
  for (const position of value) {
    if (!isCount(position, length - 1) || seen.has(position)) return false
    seen.add(position)
  }
  return true
}

/**
 * `details` as the card may show them, or undefined when they are missing or
 * do not match `result`: an unknown status, or with "ordered" positions that
 * are not a permutation of each entry's meanings or counts out of range.
 * Positions and counts are kept only with "ordered".
 */
export function usableDetails(result: DictionaryResult, details: unknown): OrderDetails | undefined {
  if (!isRecord(details) || !ORDER_STATUSES.includes(details.status as OrderStatus)) return undefined
  const status = details.status as OrderStatus
  if (status !== 'ordered') return { status }
  const { positions, offered } = details
  const entries = result.entries
  if (!Array.isArray(positions) || !Array.isArray(offered) || positions.length !== entries.length || offered.length !== entries.length) return undefined
  if (!entries.every((entry, e) => isPermutation(positions[e], entry.senses.length) && isCount(offered[e], entry.senses.length))) return undefined
  return { status, positions: positions as number[][], offered: offered as number[] }
}
