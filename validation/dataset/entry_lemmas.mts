// Recovers, for every item of the builders' item files, the headword and part of speech of each dictionary entry its
// candidates come from (a candidate id "e:s" is meaning s of entry e of the lookup), so that every offered definition
// can be traced to its Wiktionary page. The item files store the entries' sizes but not their headwords.
//
// It repeats the lookup the builders made (the extension's WiktionaryDictionary.define on the stored selection, in the
// same pack) and accepts a result only if it is the same lookup: the entries' sizes equal the stored `entrySenses`, and
// the prompts rebuilt with the extension's senseRequest for the forms 24|c1600 and 127 have the stored SHA-256 hashes.
// Run from the extension's repository (it imports its validation/common.ts and the core package; it changes nothing):
//
//   cd ~/src/contextual-dictionary && CD_VALIDATION_OUT=<scratch dir> npx tsx <dataset>/scripts/entry_lemmas.mts OUT.jsonl ITEMS.jsonl [ITEMS.jsonl ...]
//
// Output: one line per item, {"file", "id", "entries": [{"lemma", "pos"}], "check": "ok" | reason}.
import fs from 'node:fs'
import path from 'node:path'

const repo = process.cwd()
const common = await import(path.join(repo, 'validation/common.ts'))
const core = await import(path.join(repo, 'node_modules/@andrepaim/contextual-dictionary-core/dist/index.js'))
const { PATHS, VARIANTS, fileSource, readFormat, readJsonl, sha256Hex, variantRequest } = common

const [out, ...files] = process.argv.slice(2)
if (!out || !files.length) throw new Error('usage: entry_lemmas.mts OUT.jsonl ITEMS.jsonl [...]')
const variants = VARIANTS.filter((v: { key: string }) => ['24|c1600', '127'].includes(v.key))
const format = readFormat()
const source = await fileSource(PATHS.pack)
const dictionary = await core.openWiktionaryDictionary(source)
const lines: string[] = []
const counts: Record<string, number> = {}
for (const file of files) {
  const items = readJsonl(file) as { id: string; selection: { text: string; before?: string; after?: string }; entrySenses: number[]; perCap: Record<string, { prompt?: string; skip?: string }> }[]
  let n = 0
  for (const item of items) {
    if (++n % 20_000 === 0) console.error(`${path.basename(file)}: ${n}/${items.length}`)
    const result = await dictionary.define(item.selection)
    const sizes = result.entries.map((e: { senses: unknown[] }) => e.senses.length)
    let check = 'ok'
    if (JSON.stringify(sizes) !== JSON.stringify(item.entrySenses)) check = 'entry sizes differ'
    else {
      for (const variant of variants) {
        const stored = item.perCap[variant.key]
        if (!stored) continue
        const request = variantRequest(result, item.selection, format, variant)
        const rebuilt = 'skip' in request ? `skip:${request.skip}` : sha256Hex(request.prompt)
        const want = stored.prompt ?? `skip:${stored.skip}`
        if (rebuilt !== want) { check = `prompt ${variant.key} differs`; break }
      }
    }
    counts[`${path.basename(file)}: ${check}`] = (counts[`${path.basename(file)}: ${check}`] ?? 0) + 1
    lines.push(JSON.stringify({ file: path.basename(file), id: item.id, entries: result.entries.map((e: { lemma: string; partOfSpeech: string }) => ({ lemma: e.lemma, pos: e.partOfSpeech })), check }))
  }
}
await source.close()
fs.writeFileSync(out, lines.join('\n') + '\n')
console.log(JSON.stringify(counts, null, 1))
