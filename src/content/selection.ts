// What the reader selected on a page, and the page text on either side of it.
// See docs/plan.md section 5.5.
import { SELECTION_LIMITS, type Selection } from '../shared/contracts'

/** Whether a selection is short enough to be a word or a short phrase. */
export function isDefinable(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= 2 && trimmed.length <= SELECTION_LIMITS.definableChars
    && trimmed.split(/\s+/).length <= SELECTION_LIMITS.definableWords && /\p{L}/u.test(trimmed)
}

/** Whether `node` is a form field or inside one, or inside a region the reader can edit. */
export function isEditable(node: Node | null | undefined): boolean {
  const element = node instanceof Element ? node : node?.parentElement
  if (!element) return false
  if (element.closest('input, textarea, select')) return true
  // The nearest contenteditable attribute decides; "false" makes an island.
  const region = element.closest('[contenteditable]')
  if (region && region.getAttribute('contenteditable')!.toLowerCase() !== 'false') return true
  return element.ownerDocument.designMode === 'on'
}

const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'SVG', 'CANVAS'])
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'HTML', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])
const INLINE_DISPLAYS = new Set(['inline', 'contents', 'ruby', 'ruby-text'])

function style(element: Element): CSSStyleDeclaration | undefined {
  return element.ownerDocument.defaultView?.getComputedStyle(element)
}

function isBlock(element: Element): boolean {
  const display = style(element)?.display
  // Browsers always resolve a display; a DOM without styles falls back to the tag.
  return display ? !INLINE_DISPLAYS.has(display) : BLOCK_TAGS.has(element.tagName)
}

function isHidden(element: Element): boolean {
  if (SKIPPED.has(element.tagName.toUpperCase()) || element.hasAttribute('hidden')) return true
  const computed = style(element)
  return computed?.display === 'none' || computed?.visibility === 'hidden' || computed?.visibility === 'collapse'
}

/** The element or shadow root whose text bounds the context of `node`. */
function contextRoot(node: Node): Node {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (current instanceof ShadowRoot) return current
    if (current instanceof Element && isBlock(current)) return current
  }
  return node.ownerDocument?.body ?? node
}

const collapse = (text: string) => text.replace(/\s+/g, ' ')
// Collected text is collapsed and trimmed to this length as it grows, so a
// long block costs one walk and little memory.
const KEEP = SELECTION_LIMITS.contextChars * 4

interface Parts { before: string; inside: string; after: string }

/** Visible text of `root` in document order, split into before, inside and after the range. */
function splitText(root: Node, range: Range): Parts {
  let before = '', inside = '', after = '', phase: 'before' | 'inside' | 'after' = 'before', done = false
  const add = (text: string) => {
    if (phase === 'inside') {
      inside += text
      // Far too long to be a word: the rest does not matter.
      done = inside.length > KEEP
    } else if (phase === 'before') {
      before += text
      if (before.length > KEEP * 2) before = collapse(before).slice(-KEEP)
    } else if (phase === 'after') {
      after += text
      if (after.length > KEEP) { after = collapse(after); done = after.length > KEEP }
    }
  }
  const start = range.startContainer, end = range.endContainer
  // A boundary inside an element sits before one of its children, or after the last.
  const startChild = start.nodeType === Node.TEXT_NODE ? undefined : start.childNodes[range.startOffset] ?? null
  const endChild = end.nodeType === Node.TEXT_NODE ? undefined : end.childNodes[range.endOffset] ?? null
  const visit = (node: Node) => {
    if (node === startChild && phase === 'before') phase = 'inside'
    if (node === endChild) phase = 'after'
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data
      if (node === start) { add(data.slice(0, range.startOffset)); phase = 'inside' }
      const from = node === start ? range.startOffset : 0
      if (node === end) { add(data.slice(from, range.endOffset)); phase = 'after'; add(data.slice(range.endOffset)) }
      else add(data.slice(from))
      return
    }
    if (!(node instanceof Element)) return
    if (node.tagName === 'BR') { add(' '); return }
    if (isHidden(node)) return
    const block = isBlock(node)
    if (block) add(' ')
    for (let child = node.firstChild; child && !done; child = child.nextSibling) visit(child)
    if (node === start && startChild === null && phase === 'before') phase = 'inside'
    if (node === end && endChild === null) phase = 'after'
    if (block) add(' ')
  }
  for (let child = root.firstChild; child && !done; child = child.nextSibling) visit(child)
  return { before, inside, after }
}

function parts(range: Range): Parts {
  const { before, inside, after } = splitText(contextRoot(range.commonAncestorContainer), range)
  return {
    before: collapse(before).trimStart().slice(-SELECTION_LIMITS.contextChars),
    inside,
    after: collapse(after).trimEnd().slice(0, SELECTION_LIMITS.contextChars),
  }
}

/**
 * Up to 120 characters before and after `range`, from the nearest block-level
 * ancestor's visible text, with whitespace runs (line breaks and block
 * boundaries included) collapsed to one space.
 */
export function selectionContext(range: Range): { before: string; after: string } {
  const { before, after } = parts(range)
  return { before, after }
}

/**
 * The selection to look up, or null when it is not a word or short phrase,
 * or when it is in a field or region the reader can edit. `focused` is the
 * page's focused element, if any.
 */
export function readSelection(range: Range, focused?: Element | null): Selection | null {
  // A cheap first look; the visible text decides below.
  if (range.collapsed || !/\p{L}/u.test(range.toString().slice(0, KEEP))) return null
  if (isEditable(range.startContainer) || isEditable(range.endContainer) || isEditable(range.commonAncestorContainer)) return null
  if (focused && isEditable(focused)) return null
  const { inside: raw, ...context } = parts(range)
  if (!isDefinable(raw)) return null
  // A space a double-click selected next to the word belongs to the context:
  // it tells the dictionary that the word ends there.
  const before = /^\s/.test(raw) && context.before && !context.before.endsWith(' ') ? `${context.before} ` : context.before
  const after = /\s$/.test(raw) && context.after && !context.after.startsWith(' ') ? ` ${context.after}` : context.after
  return {
    text: collapse(raw).trim(),
    before: before.slice(-SELECTION_LIMITS.contextChars),
    after: after.slice(0, SELECTION_LIMITS.contextChars),
  }
}

export interface Rect { top: number; bottom: number; left: number; right: number }

/** The screen area of `range`, or null when it has none (a collapsed or hidden range). */
export function anchorRect(range: Range): Rect | null {
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0 || rect.height > 0)
  if (!rects.length) {
    const box = range.getBoundingClientRect()
    if (!box.width && !box.height) return null
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
  }
  return {
    top: Math.min(...rects.map(rect => rect.top)),
    bottom: Math.max(...rects.map(rect => rect.bottom)),
    left: Math.min(...rects.map(rect => rect.left)),
    right: Math.max(...rects.map(rect => rect.right)),
  }
}
