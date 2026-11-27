// Builds the project site published with GitHub Pages
// (https://andrepaim.github.io/contextual-dictionary/).
//
//   node scripts/build-site.mjs [output directory, default _site]
//
// The site is static: the files of site/ (anything put there, such as a site
// verification file, is published as it is; names that start with "_" are
// kept out), the home page and the practice page with the shared header and
// footer and the examples of site/_examples.json put in, the guide and the
// privacy page made from docs/user-guide.md and docs/privacy.md, and the
// extension's icons. The pictures in site/images/ and the answers in
// site/_examples.json are captures of the real extension, made by
// validation/site-assets.ts. No scripts, nothing loaded from other sites.
// Uses only Node's own modules, so the Pages workflow needs no install step.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY = 'https://github.com/andrepaim/contextual-dictionary'
const ICONS = ['icon-128.png', 'icon-32.png']
/** The documents published as pages: the address of each in docs/, and its page. */
const DOCUMENTS = { 'user-guide.md': ['guide.html', 'User guide'], 'privacy.md': ['privacy.html', 'Privacy'] }

const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = text => escapeText(text).replace(/"/g, '&quot;')
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** Only web addresses, mail addresses and addresses relative to the page are linked. */
const safeAddress = address => /^(https?:\/\/|mailto:)/i.test(address) || !/^[a-z][a-z0-9+.-]*:/i.test(address)

/** One line of Markdown text as HTML: code, bold, links and bare web addresses. */
function inline(text, link) {
  let html = '', at = 0
  for (const match of text.matchAll(/`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"`]+)/g)) {
    html += escapeText(text.slice(at, match.index))
    at = match.index + match[0].length
    const [whole, code, bold, label, address, bare] = match
    if (code !== undefined) html += `<code>${escapeText(code)}</code>`
    else if (bold !== undefined) html += `<strong>${inline(bold, link)}</strong>`
    else if (label !== undefined) html += safeAddress(address) ? `<a href="${escapeAttribute(link(address))}">${inline(label, link)}</a>` : escapeText(whole)
    else {
      // A full stop or comma after an address belongs to the sentence.
      const address = bare.replace(/[.,;:!?)]+$/, '')
      html += `<a href="${escapeAttribute(address)}">${escapeText(address)}</a>${escapeText(bare.slice(address.length))}`
    }
  }
  return html + escapeText(text.slice(at))
}

/**
 * The subset of Markdown the project's documents use, as HTML: headings,
 * paragraphs, bullet and numbered lists, tables, code, bold and links. `link` maps the
 * address of a written-out link, for example to turn a path in the
 * repository into its address on GitHub.
 */
export function markdownToHtml(markdown, link = address => address) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim(), link))
  for (let at = 0; at < lines.length;) {
    const line = lines[at]
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!line.trim()) { at++; continue }
    if (heading) {
      const level = heading[1].length
      blocks.push(`<h${level}${level > 1 ? ` id="${slug(heading[2])}"` : ''}>${inline(heading[2], link)}</h${level}>`)
      at++
    } else if (/^- /.test(line)) {
      const items = []
      for (; at < lines.length && (/^- /.test(lines[at]) || (/^\s+\S/.test(lines[at]) && items.length)); at++) {
        if (/^- /.test(lines[at])) items.push(lines[at].slice(2).trim())
        else items[items.length - 1] += ` ${lines[at].trim()}`
      }
      blocks.push(`<ul>\n${items.map(item => `<li>${inline(item, link)}</li>`).join('\n')}\n</ul>`)
    } else if (/^\d+\. /.test(line)) {
      const items = []
      for (; at < lines.length && (/^\d+\. /.test(lines[at]) || (/^\s+\S/.test(lines[at]) && items.length)); at++) {
        if (/^\d+\. /.test(lines[at])) items.push(lines[at].replace(/^\d+\. /, '').trim())
        else items[items.length - 1] += ` ${lines[at].trim()}`
      }
      blocks.push(`<ol>\n${items.map(item => `<li>${inline(item, link)}</li>`).join('\n')}\n</ol>`)
    } else if (/^\|/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[at + 1] ?? '')) {
      const head = cells(line), rows = []
      for (at += 2; at < lines.length && /^\|/.test(lines[at]); at++) rows.push(cells(lines[at]))
      blocks.push(`<table>\n<thead><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table>`)
    } else {
      const text = []
      for (; at < lines.length && lines[at].trim() && !/^(#{1,6}\s|- |\d+\. |\|)/.test(lines[at]); at++) text.push(lines[at].trim())
      blocks.push(`<p>${inline(text.join(' '), link)}</p>`)
    }
  }
  return blocks.join('\n')
}

/** The header of every page. `current` is the page's file name. */
export function siteHeader(current) {
  const home = current === 'index.html' ? '' : './'
  const link = (address, label, more = '') => `<a${more} href="${address}"${address === current ? ' aria-current="page"' : ''}>${label}</a>`
  return `<header class="site-header wrap">
<a class="brand" href="./"><img src="images/icon-128.png" width="30" height="30" alt="">Contextual Dictionary</a>
<nav aria-label="Site">${link(`${home}#examples`, 'Examples', ' class="optional"')}${link(`${home}#how`, 'How it works', ' class="optional"')}${link('guide.html', 'Guide')}${link('privacy.html', 'Privacy')}${link(`${home}#install`, 'Install', ' class="button compact"')}</nav>
</header>`
}

/** The footer of every page. */
export function siteFooter() {
  return `<footer class="site-footer"><div class="wrap">
<div class="credits"><a class="brand" href="./"><img src="images/icon-128.png" width="26" height="26" alt="">Contextual Dictionary</a>
<p>Code under the MIT licence. Definitions from <a href="https://en.wiktionary.org/">Wiktionary</a> (CC BY-SA 4.0), via <a href="https://kaikki.org/">Kaikki.org</a>. The model is fine-tuned from Ettin-150m-WSD (Apache-2.0) on Wiktionary examples, run with ONNX Runtime (MIT). Set in Newsreader and Inter (SIL Open Font License).</p></div>
<nav aria-label="Footer"><a href="guide.html">User guide</a><a href="try.html">Practice page</a><a href="privacy.html">Privacy</a><a href="${REPOSITORY}">GitHub</a><a href="${REPOSITORY}/releases">Releases</a><a href="${REPOSITORY}/issues">Support</a></nav>
</div></footer>`
}

const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
/** `text` as HTML with the first whole-word occurrence of `word` marked as a reader's selection; line breaks become " / " or `<br>`. */
function marked(text, word, lineBreak) {
  const found = new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}])`, 'u').exec(text)
  const html = found
    ? `${escapeText(text.slice(0, found.index + found[1].length))}<mark>${escapeText(found[2])}</mark>${escapeText(text.slice(found.index + found[0].length))}`
    : escapeText(text)
  return html.replace(/\n/g, lineBreak)
}

/**
 * The examples of the home page: for each sentence, the first meaning in the
 * dictionary's order and the first by context, as the extension gave them
 * (site/_examples.json, written by validation/site-assets.ts). An example
 * with `show: "miss"` is one the model does not get right, and says why.
 */
export function examplesHtml(data) {
  const items = data.examples.filter(example => example.show === 'example' || example.show === 'miss').map(example => {
    const { dictionary, context } = example.result
    const moved = context.was ? ` <span class="was">was ${ordinal(context.was)}</span>` : context.first === dictionary.first ? ' <span class="was">unchanged</span>' : ''
    return `<li>
<blockquote class="passage">“${marked(example.quote, example.word, ' / ')}”</blockquote>
<cite>${escapeText(example.source)}</cite>
<dl class="orders">
<dt>Dictionary order</dt><dd class="dictionary">${escapeText(dictionary.first)}</dd>
<dt>By context</dt><dd class="${example.show === 'miss' ? 'dictionary' : 'context'}">${escapeText(context.first)}${moved}</dd>
${example.note ? `<dt>${example.show === 'miss' ? 'A miss' : 'Note'}</dt><dd>${escapeText(example.note)}</dd>\n` : ''}</dl>
</li>`
  })
  return `<ol class="examples">\n${items.join('\n')}\n</ol>
<p class="examples-note">The extension’s own answers, version ${escapeText(data.extension)}, including one it gets wrong. With it installed you can repeat them on the <a href="try.html">practice page</a>.</p>`
}

/** The passages of the practice page: every example, in full. */
export function passagesHtml(data) {
  return data.examples.map(example => `<article id="${escapeAttribute(example.id)}">
<h2>${escapeText(example.source)}</h2>
<p>${escapeText(example.passage).replace(/\n/g, '<br>\n')}</p>
</article>`).join('\n')
}

/** `<picture>` for a capture with its dark and (if `narrow`) small-screen variants; `size(name)` gives a picture's pixel size. */
function picture(name, alt, size, { narrow = false, scale = 2 } = {}) {
  const at = file => { const [width, height] = size(file); return `width="${width / scale}" height="${height / scale}"` }
  const source = (file, media) => `<source media="${media}" srcset="images/${file}" ${at(file)}>`
  return `<picture>${narrow ? source(`${name}-narrow-dark.png`, '(max-width: 30rem) and (prefers-color-scheme: dark)') + source(`${name}-narrow.png`, '(max-width: 30rem)') : ''}${source(`${name}-dark.png`, '(prefers-color-scheme: dark)')}<img src="images/${name}.png" ${at(`${name}.png`)} alt="${escapeAttribute(alt)}"></picture>`
}

/** The opening picture of the home page: two captures of the same lookup, one for each order, and a switch between them. */
export function heroHtml(data, size) {
  const example = data.examples.find(example => example.show === 'hero')
  const { dictionary, context } = example.result
  const scene = `Chrome showing ${example.source}, with the word “${example.word}” selected and the Contextual Dictionary card open below it.`
  return `<div class="shot">
<div class="bar"><div class="segmented" role="radiogroup" aria-label="Order of the meanings"><label><input type="radio" name="order" value="context" checked><span>Order by context</span></label><label><input type="radio" name="order" value="dictionary"><span>Dictionary order</span></label></div><p>Captured in Chromium, extension version ${escapeText(data.extension)}</p></div>
<figure class="capture in-context">${picture('lookup-context', `${scene} The first meaning is “${context.first}”`, size, { narrow: true })}</figure>
<figure class="capture in-dictionary">${picture('lookup-dictionary', `${scene} The first meaning is “${dictionary.first}”`, size, { narrow: true })}</figure>
<p class="reading in-context">Ordered by context, the card opens on <b>“${escapeText(context.first)}”</b>${context.was ? ` Wiktionary lists it ${ordinal(context.was)}.` : ''}</p>
<p class="reading in-dictionary">In the dictionary’s own order, the same card opens on <b>“${escapeText(dictionary.first)}”</b></p>
</div>`
}

/** The capture of the extension's window, on the home page. */
export function windowHtml(size) {
  return `<figure><div class="capture">${picture('window', 'The extension’s window: switches for Show definitions, Order by context, Show order details and the current site, then the dictionary and the context model, each with its size and a Remove button.', size)}</div><figcaption>The extension’s window. Each download says how much disk it uses and can be removed.</figcaption></figure>`
}

/** A page of the site other than the home page, in the home page's frame. */
function page(file, title, main) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)} · Contextual Dictionary</title>
<link rel="icon" href="images/icon-32.png">
<link rel="stylesheet" href="site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${siteHeader(file)}
${main}
${siteFooter()}
</body>
</html>
`
}

/** The width and height of a PNG file, in pixels. */
function pngSize(file) {
  const bytes = fs.readFileSync(file)
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

const site = path.join(root, 'site')
/** The examples and the extension's answers for them (site/_examples.json). */
export const readExamples = () => JSON.parse(fs.readFileSync(path.join(site, '_examples.json'), 'utf8'))

/** Copies the files of site/ and the extension's icons into `outDir`, replacing what is there. */
export function copyStatic(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.cpSync(site, outDir, { recursive: true, filter: source => !path.basename(source).startsWith('_') })
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true })
  for (const icon of ICONS) fs.copyFileSync(path.join(root, 'src/icons', icon), path.join(outDir, 'images', icon))
}

/** A page of site/ (`index.html`, `try.html`) with its parts put in; `size(name)` gives the pixel size of a picture in site/images/. */
export function renderPage(file, data, size = name => pngSize(path.join(site, 'images', name))) {
  const parts = { header: () => siteHeader(file), footer: siteFooter, hero: () => heroHtml(data, size), window: () => windowHtml(size), examples: () => examplesHtml(data), passages: () => passagesHtml(data) }
  return fs.readFileSync(path.join(site, file), 'utf8').replace(/^[ \t]*<!-- ([a-z]+) -->[ \t]*$/gm, (whole, part) => parts[part] ? parts[part]() : whole)
}

/** Writes the site into `outDir`, replacing what is there. */
export function buildSite({ outDir = path.join(root, '_site') } = {}) {
  copyStatic(outDir)
  const data = readExamples()
  for (const file of ['index.html', 'try.html']) fs.writeFileSync(path.join(outDir, file), renderPage(file, data))
  // Links between the documents lead to their pages; other paths in the repository become their addresses on GitHub.
  const address = address => /^(https?:|mailto:|#)/i.test(address) ? address : DOCUMENTS[address]?.[0] ?? `${REPOSITORY}/blob/main/${path.posix.normalize(`docs/${address}`)}`
  for (const [document, [file, title]] of Object.entries(DOCUMENTS)) {
    const body = markdownToHtml(fs.readFileSync(path.join(root, 'docs', document), 'utf8'), address)
    fs.writeFileSync(path.join(outDir, file), page(file, title, `<main class="document" id="main">\n${body}\n</main>`))
  }
  return outDir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = buildSite(process.argv[2] ? { outDir: path.resolve(process.argv[2]) } : {})
  console.log(`Built ${path.relative(process.cwd(), outDir) || '.'}`)
}
