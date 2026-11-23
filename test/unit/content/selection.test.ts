// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest'
import { anchorRect, isDefinable, isEditable, readSelection, selectionContext } from '../../../src/content/selection'

afterEach(() => { document.body.innerHTML = '' })

/** A range over `word` (the n-th occurrence) inside the text of `root`. */
function rangeOver(root: Node, word: string, occurrence = 0): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node as Text).data
    let index = text.indexOf(word)
    while (index >= 0) {
      if (seen++ === occurrence) {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + word.length)
        return range
      }
      index = text.indexOf(word, index + 1)
    }
  }
  throw new Error(`"${word}" not found`)
}

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup
  return document.body
}

describe('isDefinable', () => {
  test('accepts a word or a short phrase that contains a letter', () => {
    for (const text of ['mouse', 'ad', ' mouse ', 'ice cream', 'run out of steam', 'état', 'naïve', 'x-ray', "don't", 'Mäuse'])
      expect(isDefinable(text), text).toBe(true)
  })

  test('refuses one character, numbers and symbols only, long and wordy selections', () => {
    for (const text of ['', ' ', 'a', '12', '42.5', '—–', '!!', 'one two three four five', 'a'.repeat(81), `  ${'b'.repeat(81)}  `])
      expect(isDefinable(text), JSON.stringify(text)).toBe(false)
  })

  test('limits are inclusive: 80 characters and 4 words are definable', () => {
    expect(isDefinable('a'.repeat(80))).toBe(true)
    expect(isDefinable('one two three four')).toBe(true)
    expect(isDefinable('one\ntwo\tthree  four')).toBe(true)
  })
})

describe('selectionContext', () => {
  test('takes the text on either side inside the paragraph', () => {
    const root = html('<p>Drag the mouse to move the cursor on screen.</p><p>Another paragraph.</p>')
    expect(selectionContext(rangeOver(root, 'mouse'))).toEqual({ before: 'Drag the ', after: ' to move the cursor on screen.' })
  })

  test('crosses inline elements and links', () => {
    const root = html('<p>We walked along the <a href="#">bank</a> of the <em>river</em> until the path turned <span>towards</span> the mill.</p>')
    expect(selectionContext(rangeOver(root, 'bank'))).toEqual({ before: 'We walked along the ', after: ' of the river until the path turned towards the mill.' })
    expect(selectionContext(rangeOver(root, 'towards'))).toEqual({ before: 'We walked along the bank of the river until the path turned ', after: ' the mill.' })
  })

  test('handles a selection that spans inline elements', () => {
    const root = html('<p>The neural <span>network</span> was trained.</p>')
    const range = document.createRange()
    const p = root.querySelector('p')!
    range.setStart(p.firstChild!, 4)
    range.setEnd(p.querySelector('span')!.firstChild!, 7)
    expect(range.toString()).toBe('neural network')
    expect(selectionContext(range)).toEqual({ before: 'The ', after: ' was trained.' })
  })

  test('collapses whitespace runs and counts line breaks and block boundaries as spaces', () => {
    const root = html('<div>First   line<br>second\n\n   line with <b>mouse</b>\tin it<div>nested block</div>after</div>')
    expect(selectionContext(rangeOver(root, 'mouse'))).toEqual({ before: 'First line second line with ', after: ' in it nested block after' })
  })

  test('stays inside the nearest block-level ancestor', () => {
    const root = html('<ul><li>left item</li><li>the mouse item</li><li>right item</li></ul>')
    expect(selectionContext(rangeOver(root, 'mouse'))).toEqual({ before: 'the ', after: ' item' })
  })

  test('skips hidden elements, scripts, styles and noscript', () => {
    const root = html('<p>Visible <span hidden>secret</span><span style="display:none">gone</span><span style="visibility:hidden">ghost</span><script>var x = 1</script><style>p{}</style><noscript>enable js</noscript>start mouse end<template>tpl</template></p>')
    expect(selectionContext(rangeOver(root, 'mouse'))).toEqual({ before: 'Visible start ', after: ' end' })
  })

  test('keeps at most 120 characters on each side', () => {
    const left = 'l'.repeat(300), right = 'r'.repeat(300)
    const root = html(`<p>${left} mouse ${right}</p>`)
    const { before, after } = selectionContext(rangeOver(root, 'mouse'))
    expect(before).toBe(`${'l'.repeat(119)} `)
    expect(after).toBe(` ${'r'.repeat(119)}`)
  })

  test('keeps the end of a long paragraph before the word and the start after it', () => {
    const words = Array.from({ length: 400 }, (_, index) => `w${index}`).join('   ')
    const root = html(`<p>${words} mouse ${words}</p>`)
    const { before, after } = selectionContext(rangeOver(root, 'mouse'))
    expect(before.length).toBe(120)
    expect(before.endsWith('w398 w399 ')).toBe(true)
    expect(after.length).toBe(120)
    expect(after.startsWith(' w0 w1 w2')).toBe(true)
  })

  test('does not start or end with whitespace from the block edges', () => {
    const root = html('<p>\n   mouse   \n</p>')
    expect(selectionContext(rangeOver(root, 'mouse'))).toEqual({ before: '', after: '' })
  })

  test('works when the range boundaries are elements, not text', () => {
    const root = html('<p>Before <b>bold</b> after.</p>')
    const range = document.createRange()
    range.selectNode(root.querySelector('b')!)
    expect(selectionContext(range)).toEqual({ before: 'Before ', after: ' after.' })
  })

  test('uses the shadow root as the outer limit inside a shadow tree', () => {
    html('<p>outside text <span id="host"></span></p>')
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = 'inside the <i>mouse</i> tree'
    expect(selectionContext(rangeOver(shadow, 'mouse'))).toEqual({ before: 'inside the ', after: ' tree' })
  })
})

describe('isEditable', () => {
  test('is true inside inputs, textareas, selects and contenteditable regions', () => {
    const root = html('<input id="a" value="x"><input type="password" id="b"><textarea id="c">mouse</textarea><select id="d"><option>mouse</option></select><div contenteditable="true"><p id="e">mouse</p></div><div contenteditable=""><span id="f">x</span></div><div contenteditable="plaintext-only" id="g">x</div>')
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) expect(isEditable(root.querySelector(`#${id}`)), id).toBe(true)
    expect(isEditable(root.querySelector('#c')!.firstChild)).toBe(true)
    expect(isEditable(root.querySelector('#e')!.firstChild)).toBe(true)
  })

  test('is false for ordinary text and contenteditable="false" islands', () => {
    const root = html('<p id="a">mouse</p><div contenteditable="true"><span contenteditable="false" id="b">fixed</span></div>')
    expect(isEditable(root.querySelector('#a'))).toBe(false)
    expect(isEditable(root.querySelector('#a')!.firstChild)).toBe(false)
    expect(isEditable(root.querySelector('#b'))).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})

describe('readSelection', () => {
  test('returns the trimmed text and its context, keeping the spaces a double-click selected', () => {
    const root = html('<p>Drag the mouse to move the cursor.</p>')
    const range = rangeOver(root, 'mouse ')
    expect(readSelection(range)).toEqual({ text: 'mouse', before: 'Drag the ', after: ' to move the cursor.' })
  })

  test('collapses whitespace inside a phrase that spans a line break', () => {
    const root = html('<p>The neural<br>network was trained.</p>')
    const p = root.querySelector('p')!
    const range = document.createRange()
    range.setStart(p.firstChild!, 4)
    range.setEnd(p.lastChild!, 7)
    expect(readSelection(range)).toEqual({ text: 'neural network', before: 'The ', after: ' was trained.' })
  })

  test('returns null for selections that are not definable', () => {
    const root = html('<p>one two three four five six seven</p><p>12345</p>')
    expect(readSelection(rangeOver(root, 'one two three four five'))).toBeNull()
    expect(readSelection(rangeOver(root, '12345'))).toBeNull()
  })

  test('returns null inside editable regions and when an editable element has focus', () => {
    const root = html('<div contenteditable="true">the mouse moved</div><p>plain mouse text</p><input id="field" value="x">')
    expect(readSelection(rangeOver(root, 'mouse', 0))).toBeNull()
    expect(readSelection(rangeOver(root, 'mouse', 1))).toEqual({ text: 'mouse', before: 'plain ', after: ' text' })
    expect(readSelection(rangeOver(root, 'mouse', 1), root.querySelector('#field'))).toBeNull()
  })
})

describe('anchorRect', () => {
  test('is the union of the non-empty client rectangles', () => {
    const rects = [
      { top: 10, bottom: 30, left: 50, right: 90, width: 40, height: 20 },
      { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
      { top: 30, bottom: 50, left: 5, right: 25, width: 20, height: 20 },
    ]
    const range = { getClientRects: () => rects, getBoundingClientRect: () => rects[0] } as unknown as Range
    expect(anchorRect(range)).toEqual({ top: 10, bottom: 50, left: 5, right: 90 })
  })

  test('falls back to the bounding rectangle, and is null when the range has no geometry', () => {
    const box = { top: 1, bottom: 2, left: 3, right: 4, width: 1, height: 1 }
    expect(anchorRect({ getClientRects: () => [], getBoundingClientRect: () => box } as unknown as Range)).toEqual({ top: 1, bottom: 2, left: 3, right: 4 })
    const empty = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
    expect(anchorRect({ getClientRects: () => [], getBoundingClientRect: () => empty } as unknown as Range)).toBeNull()
  })
})
