import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
// @ts-expect-error plain JavaScript build script without types
import { buildSite, examplesHtml, markdownToHtml, siteHeader } from '../../../scripts/build-site.mjs'

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

  test('numbered lists, with items continued on the next line', () => {
    expect(markdownToHtml('1. Download `it`\n   and unzip\n2. Load it\n\nAfter'))
      .toBe('<ol>\n<li>Download <code>it</code> and unzip</li>\n<li>Load it</li>\n</ol>\n<p>After</p>')
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

const PAGES = ['index.html', 'try.html', 'guide.html', 'privacy.html']
interface Example { id: string; show: string; source: string; word: string; quote: string; passage: string; note?: string; result: { dictionary: { first: string }; context: { first: string; was?: number } } }
const examples = (JSON.parse(fs.readFileSync(new URL('../../../site/_examples.json', import.meta.url), 'utf8')) as { extension: string; examples: Example[] })
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

describe('siteHeader', () => {
  test('marks the page it is on, and leads to the home page\'s sections from the other pages', () => {
    expect(siteHeader('guide.html')).toContain('<a href="guide.html" aria-current="page">Guide</a>')
    expect(siteHeader('guide.html')).toContain('href="./#install"')
    expect(siteHeader('index.html')).toContain('href="#install"')
    expect(siteHeader('index.html')).not.toContain('aria-current')
  })
})

describe('examplesHtml', () => {
  const example = (more: object) => ({ id: 'x', show: 'example', source: 'A <source>', word: 'bug', quote: 'A bug in the debugger,\nline two', passage: '', result: { dictionary: { first: 'An insect.' }, context: { first: 'A problem & more.', was: 9 } }, ...more })
  const html = (...list: object[]) => examplesHtml({ extension: '1.2.3', examples: list }) as string

  test('the sentence with the word marked, and the first meaning in each order', () => {
    const page = html(example({}))
    expect(page).toContain('<blockquote class="passage">“A <mark>bug</mark> in the debugger, / line two”</blockquote>')
    expect(page).toContain('<cite>A &lt;source&gt;</cite>')
    expect(page).toContain('<dt>Dictionary order</dt><dd class="dictionary">An insect.</dd>')
    expect(page).toContain('<dt>By context</dt><dd class="context">A problem &amp; more. <span class="was">was 9th</span></dd>')
    expect(page).toContain('version 1.2.3')
  })

  test('where the first meaning was: ordinals, and "unchanged" when the model left it first', () => {
    const was = (n: number) => html(example({ result: { dictionary: { first: 'a' }, context: { first: 'b', was: n } } }))
    for (const [n, text] of [[2, 'was 2nd'], [3, 'was 3rd'], [11, 'was 11th'], [12, 'was 12th'], [21, 'was 21st'], [40, 'was 40th']] as const) expect(was(n)).toContain(`>${text}<`)
    expect(html(example({ result: { dictionary: { first: 'a' }, context: { first: 'a' } } }))).toContain('<span class="was">unchanged</span>')
    expect(html(example({ result: { dictionary: { first: 'a' }, context: { first: 'b' } } }))).not.toContain('class="was"')
  })

  test('a miss is not set off as an answer, and says why', () => {
    const page = html(example({ show: 'miss', note: 'A separate entry.' }))
    expect(page).not.toContain('class="context"')
    expect(page).toContain('<dt>A miss</dt><dd>A separate entry.</dd>')
  })

  test('only the examples meant for the home page are listed', () => {
    const page = html(example({ show: 'hero', quote: 'hero bug' }), example({ show: 'practice', quote: 'practice bug' }), example({ quote: 'home bug' }))
    expect(page.match(/<li>/g)).toHaveLength(1)
    expect(page).toContain('home <mark>bug</mark>')
  })
})

describe('buildSite', () => {
  let out = ''
  const read = (name: string) => fs.readFileSync(path.join(out, name), 'utf8')
  beforeAll(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-site-')); buildSite({ outDir: out }) })
  afterAll(() => fs.rmSync(out, { recursive: true, force: true }))

  test('writes the four pages, the style sheet, the fonts and the pictures', () => {
    for (const name of [...PAGES, 'site.css', 'fonts/newsreader.woff2', 'fonts/inter.woff2', 'images/icon-128.png', 'images/icon-32.png', 'images/lookup-context.png', 'images/window.png', 'images/social.png']) expect(fs.existsSync(path.join(out, name)), name).toBe(true)
  })

  test('files of site/ whose name starts with "_" are not published', () => {
    expect(fs.existsSync(path.join(out, '_examples.json'))).toBe(false)
  })

  test('every part of the pages is put in', () => {
    for (const name of PAGES) expect(read(name), name).not.toMatch(/<!-- [a-z]+ -->/)
  })

  test('the pages share one header and one footer', () => {
    const footer = (page: string) => /<footer[\s\S]*<\/footer>/.exec(page)?.[0]
    const links = (page: string) => [.../<header class="site-header[\s\S]*?<\/header>/.exec(page)![0].matchAll(/>([^<]+)<\/a>/g)].map(match => match[1])
    expect(footer(read('index.html'))).toContain('Wiktionary')
    for (const name of PAGES) {
      expect(footer(read(name)), name).toBe(footer(read('index.html')))
      expect(links(read(name)), name).toEqual(['Contextual Dictionary', 'Examples', 'How it works', 'Guide', 'Privacy', 'Install'])
    }
  })

  test('the opening picture is the lookup in both orders, each with its dark and small-screen captures', () => {
    const page = read('index.html')
    expect(page.match(/type="radio" name="order"/g)).toHaveLength(2)
    const hero = examples.examples.find(example => example.show === 'hero')!
    expect(page).toContain(`opens on <b>“${escaped(hero.result.context.first)}”</b>`)
    expect(page).toContain(`opens on <b>“${escaped(hero.result.dictionary.first)}”</b>`)
    for (const order of ['context', 'dictionary']) for (const variant of ['', '-dark', '-narrow', '-narrow-dark']) expect(page).toContain(`images/lookup-${order}${variant}.png`)
  })

  test('pictures are given at the size they were captured, at two pixels to one', () => {
    const page = read('index.html')
    const sized = [...page.matchAll(/<(?:img src|source [^>]*srcset)="(images\/(?:lookup|window)[^"]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    expect(sized.length).toBe(10)
    for (const [, file, width, height] of sized) {
      const bytes = fs.readFileSync(path.join(out, file!))
      expect([Number(width) * 2, Number(height) * 2], file).toEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)])
    }
  })

  test('the home page lists the extension\'s answers for the examples, the practice page every passage', () => {
    const home = read('index.html'), practice = read('try.html')
    const listed = examples.examples.filter(example => example.show === 'example' || example.show === 'miss')
    expect(listed.length).toBeGreaterThan(2)
    expect(listed.some(example => example.show === 'miss')).toBe(true)
    for (const example of listed) {
      expect(home, example.id).toContain(escaped(example.result.dictionary.first))
      expect(home, example.id).toContain(escaped(example.result.context.first))
    }
    for (const example of examples.examples) {
      expect(practice, example.id).toContain(`<article id="${example.id}">`)
      expect(practice, example.id).toContain(escaped(example.passage.split('\n')[0]!))
      expect(example.passage, example.id).toContain(example.word)
      expect(example.quote, example.id).toContain(example.word)
    }
  })

  test('the guide and the privacy page are docs/user-guide.md and docs/privacy.md', () => {
    const privacy = read('privacy.html'), guide = read('guide.html')
    expect(privacy).toContain('<title>Privacy · Contextual Dictionary</title>')
    expect(privacy).toContain('<h1>Privacy</h1>')
    expect(privacy).toContain('<h2 id="what-it-sends">What it sends</h2>')
    expect(privacy).toContain('<td><code>unlimitedStorage</code></td>')
    expect(guide).toContain('<title>User guide · Contextual Dictionary</title>')
    expect(guide).toContain('<h2 id="order-details">Order details</h2>')
    expect(guide).toMatch(/<ol>\n<li>Open <a href="https:\/\/chromewebstore\.google\.com\/detail\/contextual-dictionary\/jdjkhefpmejijkjdknchpnghijibnali">/)
    expect(guide).toContain('href="privacy.html"')
    for (const [document, page] of [['privacy.md', privacy], ['user-guide.md', guide]] as const) {
      const headings = fs.readFileSync(new URL(`../../../docs/${document}`, import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3))
      expect(headings.length).toBeGreaterThan(3)
      for (const heading of headings) expect(page, heading).toContain(`>${escaped(heading)}</h2>`)
    }
  })

  test('the pages run no scripts and load nothing from other sites', () => {
    for (const name of PAGES) {
      const page = read(name)
      expect(page, name).not.toMatch(/<script|<iframe|\son\w+=|@import|url\(\s*["']?https?:/i)
      for (const [, , address] of page.matchAll(/<(img|link|source)\b[^>]*?\s(?:src|href|srcset)="([^"]+)"/g)) expect(address, name).not.toMatch(/^(https?:)?\/\//)
    }
    expect(read('site.css')).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i)
  })

  test('every local address in the pages and the style sheet is a file of the site', () => {
    for (const name of PAGES) {
      for (const [, address] of read(name).matchAll(/\s(?:src|href|srcset)="([^"#]*)(?:#[^"]*)?"/g)) {
        if (!address || /^(https?:|mailto:)/.test(address)) continue
        expect(fs.existsSync(path.join(out, address)), `${name}: ${address}`).toBe(true)
      }
    }
    for (const [, address] of read('site.css').matchAll(/url\("([^"]+)"\)/g)) expect(fs.existsSync(path.join(out, address!)), address).toBe(true)
  })

  test('links to a section of the home page lead to a section it has', () => {
    const home = read('index.html')
    for (const name of PAGES) for (const [, id] of read(name).matchAll(/href="(?:\.\/)?#([^"]+)"/g)) expect(home, `${name}: #${id}`).toContain(`id="${id}"`)
  })

  test('the home page installs from the Chrome Web Store: the opening button and the first step lead to the listing', () => {
    const page = read('index.html')
    const store = 'href="https://chromewebstore.google.com/detail/contextual-dictionary/jdjkhefpmejijkjdknchpnghijibnali"'
    expect(/<p class="actions">[\s\S]*?<\/p>/.exec(page)![0]).toContain(`<a class="button" ${store}>`)
    expect(/id="install"[\s\S]*?<ol class="steps">[\s\S]*?<\/li>/.exec(page)![0]).toContain(`<a class="button" ${store}>`)
    expect(page).not.toMatch(/under review|Until it is approved/)
  })

  test('the home page links to the ZIP download, the source, the guide, the privacy page and the practice page', () => {
    const page = read('index.html')
    expect(page).toContain('href="https://github.com/andrepaim/contextual-dictionary/releases/latest"')
    expect(page).toContain('href="https://github.com/andrepaim/contextual-dictionary"')
    for (const name of ['guide.html', 'privacy.html', 'try.html']) expect(page).toContain(`href="${name}"`)
  })

  test('other files in site/, such as a site verification file, are published as they are', () => {
    expect(read('robots.txt')).toBe(fs.readFileSync(new URL('../../../site/robots.txt', import.meta.url), 'utf8'))
  })
})
