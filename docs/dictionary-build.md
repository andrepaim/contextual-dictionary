# Building the dictionary pack

The extension's definitions come from one file, `wiktionary-en-v1.pack` (format: `docs/pack-format.md`), built from Kaikki.org's wiktextract extract of the English Wiktionary. The pack is a release asset: it is never committed. Only its statistics are, in `docs/dictionary-stats.json`.

## Build

```bash
npx tsx scripts/build-dictionary.ts \
  --input ~/.cache/contextual-dictionary/kaikki/english-2026-10-30.jsonl.gz \
  --output ~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack \
  --stats docs/dictionary-stats.json
```

The input can be gzipped or plain JSONL. Options, with their defaults:

| Option | Default | Meaning |
| --- | --- | --- |
| `--snapshot` | date in the file name | The extract's date, written to the header |
| `--examples` | `2` | Examples kept per meaning |
| `--example-chars` | `240` | Longest example kept, after white space is collapsed |
| `--no-labels` | labels on | Leave out qualifiers such as "(transitive)" or "(nautical)" in front of definitions |
| `--include-pos`, `--exclude-pos` | excluded: `name`, `character`, `symbol`, `punct` | Change which Kaikki parts of speech are left out; repeatable |
| `--block-size` | `65536` | Target block size before compression |
| `--level` | `9` | gzip level |
| `--sort-chunk-mb` | `16` | Entries sorted in memory before a run is written to the temporary directory |
| `--temp-dir` | the system's | Where the sort runs go (about the uncompressed size of the records, some 230 MB for the full extract; removed afterwards) |

## Scope

What `src/dict/kaikki.ts` does with each Kaikki record (one part of speech of one Wiktionary page):

- **Left out:** proper names (`name`), single characters (`character`), symbols (`symbol`), punctuation (`punct`), headwords with no letter (`&`, `42`), records of another language, records with no sense left. Single-letter words with an ordinary part of speech stay ("a", "I").
- **Inflections:** a sense with `form_of` becomes a pointer `{ l: base, n: gloss }` ("plural of mouse"). An entry can have pointers and ordinary meanings. Senses with `alt_of` ("Alternative spelling of …", "Abbreviation of …") stay ordinary meanings.
- **Definitions:** gloss levels are joined, since later levels are sub-meanings. A level that repeats its parent stands alone, a level starting with an ellipsis continues its parent's sentence, and any other level follows its parent after a colon. The leading qualifier of the raw gloss is put in front ("(computing) A computer input device …"). Leftover wiki and HTML markup is removed: templates, links, formatting tags, bold and italic quotes, and a few entities. Empty glosses are dropped.
- **Examples:** usage examples come before quotations, at most two per meaning, each at most 240 characters with white space collapsed. Longer ones are skipped, not cut. Duplicates are dropped.
- **Keys:** `normalizeKey` (NFC, lower case, apostrophes and Unicode hyphens unified). Entries under one key are ordered by spelling, then by position in the extract.

## Determinism

The same input gives a byte-identical pack, however the external sort is split. It was checked on the full extract: builds with 64 MB and 16 MB sort chunks gave the same SHA-256. The order is fully defined (key, spelling, line number). Gzip headers carry no time and a fixed OS byte, and the header holds no build time. The blocks are compressed with Node's bundled zlib, so a Node release with a different zlib could change the compressed bytes, though not the content. The build below used Node v22.23.1.

## The build of 2026-11-23

| | |
| --- | --- |
| Input | `english-2026-10-30.jsonl.gz`, 534,186,395 bytes, SHA-256 `4d03b6cba283744756c57ff661c2c6cbfe34fcf8ff513a966576cf7d97e91a99`, 1,499,161 records |
| Output | `wiktionary-en-v1.pack`, **66,467,698 bytes** (63.4 MiB), SHA-256 **`e698a7117d4a684d554c1c5850674ed9035c2daab7dbd8125c6c63758b6e6c32`** |
| Contents | 1,188,915 keys; 1,294,213 entries; 1,011,441 meanings; 457,511 examples; 501,767 inflection pointers; 3,545 blocks; index 53,875 bytes |
| Left out | 202,381 names, 241 characters, 468 symbols, 60 punctuation entries, 499 without a letter, 1,298 without any gloss, 1 without a word |
| Markup | 75 kept glosses had markup removed; 2 senses without gloss were dropped inside kept entries |
| Meanings per key | p50 1, p90 2, p99 7, p99.9 23, max 156 ("draw"), over the 724,204 keys with meanings; then "a." 128, "run" 117, "break" 105, "take" 102, "set" 99 |
| Time and memory | 51 s wall clock, 317 MB peak resident memory with 16 MB sort chunks; 83 s and 804 MB with 64 MB chunks. 24-thread WSL2 machine, Node v22.23.1, single-threaded build |

The pack is smaller than the earlier estimate of 80–95 MB for this scope. Inflections are stored as short pointers instead of full entries, and the blocks are compressed at level 9.

## Spot checks

Run the opt-in test against a built pack. It reads the file by byte range, as the extension does:

```bash
CD_TEST_PACK=~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack \
  npx vitest run test/unit/dict/real-pack.test.ts --silent=false
```

Results on the pack above. "Cold" is the first lookup, which reads and inflates blocks. "Warm" is the same lookup again, served from the block cache. Times are from Node 22 on the machine above. Opening the pack (header and index) took 25 ms.

| Selection in context | Cold | Warm | First entries |
| --- | --- | --- | --- |
| Drag the [mouse] to move the cursor on screen. | 9.1 ms | 0.25 ms | mouse (noun), mouse (verb) |
| She deposited the cheque at the [bank] on Monday. | 10.6 ms | 0.09 ms | bank (noun), bank (verb), bank (noun), … |
| I [run] every morning. | 5.1 ms | 0.08 ms | run (verb), run (noun), run (adj); 118 meanings |
| Three blind [mice] ran away. | 4.5 ms | 0.11 ms | mouse (noun) with note "plural of mouse", mice (verb) |
| We trained a neural [network] on images. | 5.0 ms | 0.08 ms | neural network (noun), network (noun), network (verb) |
| [neural network] | 0.03 ms | 0.01 ms | neural network (noun) |
| [Running] is good exercise. | 1.4 ms | 0.12 ms | run (verb) with note "present participle and gerund of run", rin (verb), running (adj), … |
| I [don’t] know. | 3.4 ms | 0.07 ms | don't know (noun, phrase), don't (verb), … |
| at five [o’clock]. | 5.1 ms | 0.17 ms | five o'clock (noun), o'clock (adv) |
| the [giraffe’s] neck | 3.3 ms | 0.19 ms | giraffe (noun), found by stripping "’s" |
| She [went] home. | 6.7 ms | 0.08 ms | go home (verb) with note "simple past of go home", go (verb), wend (verb), went (noun) |
| [qwzxqvplk] | 3.4 ms | 0.03 ms | no entries |

A cold lookup reads up to about ten records: every run of up to four words around the selection that could be a compound, then the word itself. These fall in different blocks, so the first lookup on a page costs a few block reads. Later lookups mostly hit the 16-block cache.
