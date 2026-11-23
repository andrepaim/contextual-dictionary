import fs from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { ICON_SIZES, encodePng, renderIcon } from '../../../scripts/make-icons.mjs'

/** Width, height and RGBA pixels of a PNG written by encodePng (8-bit RGBA, no interlace, filter 0). */
function decode(png: Uint8Array) {
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8, width = 0, height = 0
  const data: Uint8Array[] = []
  while (at < png.length) {
    const length = view.getUint32(at), type = new TextDecoder().decode(png.slice(at + 4, at + 8))
    const body = png.slice(at + 8, at + 8 + length)
    if (type === 'IHDR') { width = view.getUint32(at + 8); height = view.getUint32(at + 12); expect([...body.slice(8)]).toEqual([8, 6, 0, 0, 0]) }
    if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const pixels = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    expect(raw[row * (width * 4 + 1)]).toBe(0)
    pixels.set(raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)), row * width * 4)
  }
  return { width, height, pixels }
}

describe('icons', () => {
  test('come in the four sizes Chrome uses', () => {
    expect(ICON_SIZES).toEqual([16, 32, 48, 128])
  })

  test.each([16, 32, 48, 128])('the committed %i px icon is what the script draws', size => {
    const committed = decode(new Uint8Array(fs.readFileSync(new URL(`../../../src/icons/icon-${size}.png`, import.meta.url))))
    expect(committed.width).toBe(size)
    expect(committed.height).toBe(size)
    expect(Buffer.from(committed.pixels).equals(Buffer.from(renderIcon(size)))).toBe(true)
  })

  test('the drawing is a blue tile with a white book, transparent corners', () => {
    const size = 128, pixels: Uint8Array = renderIcon(size)
    const at = (x: number, y: number) => [...pixels.slice((y * size + x) * 4, (y * size + x) * 4 + 4)]
    expect(at(0, 0)[3]).toBe(0)
    expect(at(64, 12)).toEqual([9, 105, 218, 255])
    expect(at(40, 64)).toEqual([255, 255, 255, 255])
    expect(at(88, 64)).toEqual([255, 255, 255, 255])
  })

  test('encodePng writes a valid image of the pixels it is given', () => {
    const pixels = new Uint8Array(2 * 2 * 4).fill(200)
    const decoded = decode(encodePng(2, 2, pixels))
    expect(decoded).toEqual({ width: 2, height: 2, pixels })
  })
})
