// Draws the extension's icons: a blue rounded tile with a white open book.
//
//   node scripts/make-icons.mjs      writes src/icons/icon-{16,32,48,128}.png
//
// No image libraries: each pixel is sampled 8 × 8 times against a few simple
// shapes, and the PNG is written by hand. The drawing depends only on this
// file, and test/unit/build/icons.test.ts checks the committed icons match it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

export const ICON_SIZES = [16, 32, 48, 128]
const BLUE = [9, 105, 218]
const WHITE = [255, 255, 255]
const SAMPLES = 8

/** Whether (x, y) is inside the rounded tile (unit square, inset 0.04, corner radius 0.2). */
function inTile(x, y) {
  const inset = 0.04, radius = 0.2
  const cx = Math.min(Math.max(x, inset + radius), 1 - inset - radius)
  const cy = Math.min(Math.max(y, inset + radius), 1 - inset - radius)
  return x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/** The two pages: between their outer and inner edges, below a top edge that rises outwards, above a bottom edge parallel to it. */
function pageOffset(x, y) {
  if (x >= 0.18 && x <= 0.48) return y - (0.30 + 0.2 * (x - 0.18))
  if (x >= 0.52 && x <= 0.82) return y - (0.36 - 0.2 * (x - 0.52))
  return -1
}

function colour(x, y, lines) {
  if (!inTile(x, y)) return null
  const depth = pageOffset(x, y)
  if (depth < 0 || depth > 0.40) return BLUE
  // Lines of text on the pages, at the larger sizes only.
  if (lines && [0.12, 0.22, 0.32].some(offset => Math.abs(depth - offset) <= 0.018) && (x < 0.46 || x > 0.54) && (x > 0.22 && x < 0.78)) return BLUE
  return WHITE
}

/** RGBA pixels of the icon at `size` × `size`. */
export function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4)
  const lines = size >= 32
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inside = 0
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const found = colour((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, lines)
          if (!found) continue
          inside++
          for (let channel = 0; channel < 3; channel++) sum[channel] += found[channel]
        }
      }
      const at = (py * size + px) * 4
      if (inside) for (let channel = 0; channel < 3; channel++) pixels[at + channel] = Math.round(sum[channel] / inside)
      pixels[at + 3] = Math.round((255 * inside) / (SAMPLES * SAMPLES))
    }
  }
  return pixels
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** An 8-bit RGBA PNG of `pixels`. */
export function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let row = 0; row < height; row++) Buffer.from(pixels.subarray(row * width * 4, (row + 1) * width * 4)).copy(raw, row * (width * 4 + 1) + 1)
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../src/icons/', import.meta.url))
  fs.mkdirSync(directory, { recursive: true })
  for (const size of ICON_SIZES) fs.writeFileSync(path.join(directory, `icon-${size}.png`), encodePng(size, size, renderIcon(size)))
  console.log(`Wrote ${ICON_SIZES.map(size => `icon-${size}.png`).join(', ')} to src/icons/`)
}
