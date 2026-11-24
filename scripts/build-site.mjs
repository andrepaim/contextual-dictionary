// Builds the project site published with GitHub Pages
// (https://andrepaim.github.io/contextual-dictionary/).
//
//   node scripts/build-site.mjs [output directory, default _site]
//
// The site is static: site/ as it is (the home page, the style sheet and
// anything else put there, such as a site verification file), the privacy
// page made from docs/privacy.md, and images from store/ and src/icons/.
// No scripts, nothing loaded from other sites. Uses only Node's own modules,
// so the Pages workflow needs no install step.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const REPOSITORY = 'https://github.com/andrepaim/contextual-dictionary'
const IMAGES = [
  ['src/icons/icon-128.png', 'icon-128.png'],
  ['src/icons/icon-32.png', 'icon-32.png'],
  ['docs/images/hamlet-moment-context.png', 'hamlet-moment-context.png'],
  ...['screenshot-1-context.png', 'screenshot-2-compare.png', 'screenshot-3-any-page.png', 'screenshot-4-details.png', 'screenshot-5-private.png'].map(name => [`store/${name}`, name]),
]

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
 * paragraphs, bullet lists, tables, code, bold and links. `link` maps the
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
    } else if (/^\|/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[at + 1] ?? '')) {
      const head = cells(line), rows = []
      for (at += 2; at < lines.length && /^\|/.test(lines[at]); at++) rows.push(cells(lines[at]))
      blocks.push(`<table>\n<thead><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr></thead>\n<tbody>\n${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}\n</tbody>\n</table>`)
    } else {
      const text = []
      for (; at < lines.length && lines[at].trim() && !/^(#{1,6}\s|- |\|)/.test(lines[at]); at++) text.push(lines[at].trim())
      blocks.push(`<p>${inline(text.join(' '), link)}</p>`)
    }
  }
  return blocks.join('\n')
}

/** A page of the site other than the home page, in the home page's frame. */
function page(title, body) {
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
<header class="top"><a class="brand" href="./"><img src="images/icon-128.png" alt="" width="32" height="32">Contextual Dictionary</a><nav><a href="privacy.html">Privacy</a><a href="${REPOSITORY}">GitHub</a></nav></header>
<main class="document">
${body}
</main>
<footer><p><a href="./">Contextual Dictionary</a> · <a href="${REPOSITORY}">Source on GitHub</a></p></footer>
</body>
</html>
`
}

/** Writes the site into `outDir`, replacing what is there. */
export function buildSite({ outDir = path.join(root, '_site') } = {}) {
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.cpSync(path.join(root, 'site'), outDir, { recursive: true })
  fs.copyFileSync(path.join(root, 'packages/core/src/card.css'), path.join(outDir, 'card.css'))
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true })
  for (const [from, name] of IMAGES) fs.copyFileSync(path.join(root, from), path.join(outDir, 'images', name))
  // Paths in the repository's documents become their addresses on GitHub.
  const onGitHub = address => /^(https?:|mailto:|#)/i.test(address) ? address : `${REPOSITORY}/blob/main/${path.posix.normalize(`docs/${address}`)}`
  fs.writeFileSync(path.join(outDir, 'privacy.html'), page('Privacy', markdownToHtml(fs.readFileSync(path.join(root, 'docs/privacy.md'), 'utf8'), onGitHub)))
  return outDir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = buildSite(process.argv[2] ? { outDir: path.resolve(process.argv[2]) } : {})
  console.log(`Built ${path.relative(process.cwd(), outDir) || '.'}`)
}
