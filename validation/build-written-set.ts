// The small hand-written set: sentences in the style of ordinary web pages
// (news, documentation, forums, recipes) with a target word, in
// validation/data/written-raw.tsv (genre, sentence, target as it appears),
// and the meaning judged correct in validation/data/written-labels.tsv. Both
// were written by the agent that ran stage 3 (a model), and the labels were
// chosen before the model was run on the sentences; no human reviewed them.
//
//   npx tsx validation/build-written-set.ts --list   # prints each sentence's meanings in the pack, for labelling
//   npx tsx validation/build-written-set.ts          # writes written-items.jsonl and adds the prompts to prompts.jsonl
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openWiktionaryDictionary } from '@andrepaim/contextual-dictionary-core'
import { PATHS, fileSource, readFormat, readJsonl, selectionAt, tokenCounter, variantPrompts, type StoredPrompt } from './common'

const { values } = parseArgs({ options: { list: { type: 'boolean', default: false } } })
const data = new URL('./data/', import.meta.url)
const rows = fs.readFileSync(new URL('written-raw.tsv', data), 'utf8').split('\n').filter(Boolean).map((line, i) => {
  const [genre, text, target] = line.split('\t') as [string, string, string]
  const start = text.search(new RegExp(`(?<![\\p{L}])${target}(?![\\p{L}])`, 'u'))
  if (start < 0) throw new Error(`line ${i + 1}: target not found`)
  return { id: `w${String(i + 1).padStart(3, '0')}`, genre, text, target, start, end: start + target.length }
})

const source = await fileSource(PATHS.pack)
const dictionary = await openWiktionaryDictionary(source)

if (values.list) {
  for (const row of rows) {
    const result = await dictionary.define(selectionAt(row.text, row.start, row.end))
    console.log(`\n${row.id} [${row.genre}] ${row.text}  <${row.target}>`)
    result.entries.forEach((entry, e) => {
      console.log(`  ${e} ${entry.lemma} (${entry.partOfSpeech})${entry.note ? ` — ${entry.note}` : ''}`)
      entry.senses.forEach((sense, s) => console.log(`    ${s} ${sense.definition}`))
    })
  }
  process.exit(0)
}

const labels = new Map(fs.readFileSync(new URL('written-labels.tsv', data), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => {
  const [id, lemma, pos, sense, prefix] = line.split('\t') as [string, string, string, string, string]
  return [id, { lemma, pos, sense: Number(sense), prefix }]
}))
const format = readFormat()
const tokens = tokenCounter()
const prompts = new Map(readJsonl<StoredPrompt>(path.join(PATHS.out, 'prompts.jsonl')).map(prompt => [prompt.hash, prompt]))
const items: unknown[] = []
const unlabelled: string[] = []
for (const row of rows) {
  const label = labels.get(row.id)
  if (!label) throw new Error(`${row.id}: no label`)
  if (label.lemma === '-') { unlabelled.push(row.id); continue }
  const selection = selectionAt(row.text, row.start, row.end)
  const result = await dictionary.define(selection)
  const entry = result.entries.findIndex(item => item.lemma === label.lemma && item.partOfSpeech === label.pos && item.senses[label.sense]?.definition.startsWith(label.prefix))
  if (entry < 0) throw new Error(`${row.id}: labelled meaning not found`)
  const perCap = variantPrompts(result, selection, { entry, sense: label.sense }, format, tokens, prompts)
  items.push({
    id: row.id, word: row.target.toLowerCase(), genre: row.genre, pos: label.pos, meanings: result.entries[entry]!.senses.length,
    selection, labelled: { entry, sense: label.sense },
    entrySenses: result.entries.map(item => item.senses.length), total: result.entries.reduce((sum, item) => sum + item.senses.length, 0), perCap,
  })
}
await source.close()
fs.writeFileSync(path.join(PATHS.out, 'written-items.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n')
fs.writeFileSync(path.join(PATHS.out, 'prompts.jsonl'), [...prompts.values()].map(item => JSON.stringify(item)).join('\n') + '\n')
console.log(`${items.length} written items; left out, no meaning in the pack fits: ${unlabelled.join(', ') || 'none'}`)
