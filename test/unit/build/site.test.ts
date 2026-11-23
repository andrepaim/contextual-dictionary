import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { buildSite, markdownToHtml } from '../../../scripts/build-site.mjs'

describe('markdownToHtml', () => {
  test('headings, paragraphs and inline marks', () => {
    expect(markdownToHtml('# Privacy\n\nIt runs **on your computer**, with `storage`.\nSecond line.\n\n## What it reads'))
      .toBe('<h1>Privacy</h1>\n<p>It runs <strong>on your computer</strong>, with <code>storage</code>. Second line.</p>\n<h2 id="what-it-reads">What it reads</h2>')
  })

  test('text is escaped, also inside code', () => {
    expect(markdownToHtml('A <script> & `<all_urls>` "quoted"')).toBe('<p>A &lt;script&gt; &amp; <code>&lt;all_urls&gt;</code> "quoted"</p>')
  })

  test('lists, with items continued on the next line', () => {
    expect(markdownToHtml('- **One:** first\n  continued\n- Two\n\nAfter'))
      .toBe('<ul>\n<li><strong>One:</strong> first continued</li>\n<li>Two</li>\n</ul>\n<p>After</p>')
  })

  test('tables', () => {
    expect(markdownToHtml('| Permission | Why |\n| --- | --- |\n| `storage` | To keep the settings. |'))
      .toBe('<table>\n<thead><tr><th>Permission</th><th>Why</th></tr></thead>\n<tbody>\n<tr><td><code>storage</code></td><td>To keep the settings.</td></tr>\n</tbody>\n</table>')
  })

  test('links: written out, and bare addresses without the sentence\'s full stop', () => {
    expect(markdownToHtml('See [the report](docs/validation.md) or https://example.org/issues.'))
      .toBe('<p>See <a href="docs/validation.md">the report</a> or <a href="https://example.org/issues">https://example.org/issues</a>.</p>')
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('href="javascript')
  })
})

describe('buildSite', () => {
  let out = ''
  const read = (name: string) => fs.readFileSync(path.join(out, name), 'utf8')
  beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-site-')); buildSite({ outDir: out }) })
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }))

  test('writes the two pages, the style sheet and the images', () => {
    for (const name of ['index.html', 'privacy.html', 'site.css', 'images/icon-128.png', 'images/screenshot-2-compare.png']) expect(fs.existsSync(path.join(out, name)), name).toBe(true)
  })

  test('the privacy page is docs/privacy.md', () => {
    const page = read('privacy.html')
    expect(page).toContain('<title>Privacy · Contextual Dictionary</title>')
    expect(page).toContain('<h1>Privacy</h1>')
    expect(page).toContain('<h2 id="what-it-sends">What it sends</h2>')
    expect(page).toContain('<td><code>unlimitedStorage</code></td>')
    const headings = fs.readFileSync(new URL('../../../docs/privacy.md', import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3))
    expect(headings.length).toBeGreaterThan(3)
    for (const heading of headings) expect(page, heading).toContain(`>${heading}</h2>`)
  })

  test('the pages run no scripts and load nothing from other sites', () => {
    for (const name of ['index.html', 'privacy.html']) {
      const page = read(name)
      expect(page).not.toMatch(/<script|<iframe|\son\w+=|@import|url\(\s*["']?https?:/i)
      for (const [, , address] of page.matchAll(/<(img|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)) expect(address, name).not.toMatch(/^(https?:)?\/\//)
    }
  })

  test('every local address in the pages is a file of the site', () => {
    for (const name of ['index.html', 'privacy.html']) {
      for (const [, address] of read(name).matchAll(/\s(?:src|href)="([^"#]+)(?:#[^"]*)?"/g)) {
        if (/^(https?:|mailto:)/.test(address!)) continue
        expect(fs.existsSync(path.join(out, address!)), `${name}: ${address}`).toBe(true)
      }
    }
  })

  test('the home page links to the download, the source and the privacy page', () => {
    const page = read('index.html')
    expect(page).toContain('href="https://github.com/andrepaim/contextual-dictionary/releases/latest"')
    expect(page).toContain('href="https://github.com/andrepaim/contextual-dictionary"')
    expect(page).toContain('href="privacy.html"')
  })

  test('other files in site/, such as a site verification file, are published as they are', () => {
    expect(read('robots.txt')).toBe(fs.readFileSync(new URL('../../../site/robots.txt', import.meta.url), 'utf8'))
  })
})
