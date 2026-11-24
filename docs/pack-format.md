# Dictionary pack format, version 1

A pack holds the whole dictionary in one file. The reader opens the header and index, then inflates individual blocks by byte range. The builder in `scripts/build-dictionary.ts` uses `PackWriter` from `@andrepaim/contextual-dictionary-core/pack`. The core reader runs in Chromium and Node 22 and reads from a `ByteSource`.

## Layout

All integers are unsigned 32-bit little-endian.

| Offset | Size | Contents |
| --- | --- | --- |
| 0 | 4 | Magic: the ASCII bytes `CDPK` |
| 4 | 4 | Format version: `1` |
| 8 | 4 | `headerLength`: bytes of header JSON that follow |
| 12 | `headerLength` | Header: a UTF-8 JSON object, possibly followed by spaces |
| `12 + headerLength` | … | Blocks, back to back, in key order |
| `indexOffset` | `indexLength` | Index: one gzip member holding a JSON array |

The index is the last thing in the file: `indexOffset + indexLength` equals the file size, which is how a truncated file is recognised.

## Header

```json
{
  "format": "cdpk", "version": 1,
  "language": "en", "source": "Wiktionary", "license": "CC BY-SA 4.0",
  "createdFrom": "english-2026-10-30.jsonl.gz sha256:4d03…", "snapshot": "2026-10-30",
  "options": { "maxExamples": 2, "maxExampleChars": 240, "labels": true, "excludedPos": ["name", "character", "symbol", "punct"] },
  "keyCount": 0, "entryCount": 0, "senseCount": 0, "pointerCount": 0,
  "blockCount": 0, "blockSize": 65536, "indexOffset": 0, "indexLength": 0
}
```

- `version` repeats the binary version; a reader refuses a header whose version differs.
- `options` records the builder's scope options, for provenance only.
- `keyCount` counts records, `entryCount` entries, `senseCount` meanings and `pointerCount` inflection pointers.
- `blockSize` is the target size of a block before compression.
- `indexOffset` and every block offset are absolute file offsets. Because the header holds the index position, the writer grows its guess of the header length until it holds, and pads the header JSON with spaces when it comes out shorter than the space it was given (JSON allows trailing white space).

## Blocks

Each block is one gzip member (RFC 1952) whose content is UTF-8 text: one JSON record per line, each line ending in `\n`, records in strictly increasing key order. A new block starts when adding the next record would take the current block past `blockSize` bytes; a record larger than `blockSize` gets a block of its own. Block boundaries never split a record, and each key appears in exactly one record.

The gzip header of every member (blocks and index) is normalised: modification time 0 and OS byte 255 ("unknown"), so the platform does not change the bytes.

## Index

One gzip member holding a JSON array with one item per block, in file order:

```json
[{ "firstKey": "a", "offset": 4211, "length": 18833 }, …]
```

`firstKey` is the key of the block's first record, `offset` its absolute position, `length` its compressed size. Blocks are contiguous: the first starts right after the header and each next one where the previous ends; the last ends at `indexOffset`. A reader checks all of this, and that the first keys increase, when it opens the pack.

To find a key, a reader binary-searches the index for the last block whose `firstKey` is not after the key, inflates that block and looks for the record. A key before the first block's first key is absent.

## Keys and key order

A key is `normalizeKey(text)` from `@andrepaim/contextual-dictionary-core`, applied by the builder to each headword and by the lookup to each selection:

1. Unicode NFC.
2. `’ ‘ ʼ ＇` become `'`; `“ ”` become `"`.
3. The hyphens U+2010 and U+2011 become `-`; soft hyphens (U+00AD) are removed. En and em dashes stay.
4. Runs of white space become one space; leading and trailing space is trimmed.
5. `toLowerCase()`, then NFC again.

Compatibility characters (ligatures, superscripts) and diacritics are kept: `café` and `cafe` are different keys.

Keys are ordered by UTF-16 code units, the order of JavaScript's `<` on strings (`compareKeys` in `@andrepaim/contextual-dictionary-core/pack`). The builder, writer and reader all use this order.

## Records

```json
{"k":"mice","e":[{"w":"mice","p":"noun","f":[{"l":"mouse","n":"plural of mouse"}]},{"w":"mice","p":"verb","s":["(Bermuda) To be distracted or inattentive."]}]}
```

| Field | Meaning |
| --- | --- |
| `k` | The key. Always the first field. |
| `e` | The entries under this key, in dictionary order (see below). |
| `e[].w` | The headword as Wiktionary spells it (`Polish`, `polish`, `MOUSE`). |
| `e[].p` | Kaikki's part of speech: `noun`, `verb`, `adj`, `adv`, `intj`, `phrase`, `prep_phrase`, `contraction`, `prefix`, `suffix`, … |
| `e[].s` | Optional. Meanings in Wiktionary's order. A meaning is a string (the definition) or an array `[definition, example, …]`. |
| `e[].f` | Optional. Inflection pointers `{ l, n }`: `l` the base word as spelled, `n` the inflection's own gloss, used as the card's note ("simple past of run"). |

An entry has `s`, `f` or both. An entry with both is a Wiktionary part-of-speech section that has inflection senses and senses of its own ("better", adverb: "comparative form of well" and others); the lookup shows the base word's entries first, then the entry's own meanings.

This refines the plan's sketch, where pointers sat in a separate top-level `f` field: keeping them inside the entries keeps Wiktionary's order between an inflection and the other entries of the same word ("mice": the plural of "mouse" comes before the rare verb), and gives each pointer its part of speech without repeating it.

**Order of entries under one key.** By spelling `w` (code units, so `MOUSE` and `Polish` come before `mouse` and `polish`), then by position in the Kaikki extract, which follows Wiktionary's page order (etymologies, then sections). The lookup re-ranks by spelling for each selection (as selected, then lower case, then other spellings), keeping this order within each rank.

## Errors

The reader rejects with a `CodedError`:

| Code | When |
| --- | --- |
| `PACK_INVALID` | Shorter than 12 bytes, or the magic is not `CDPK`: not a pack. |
| `PACK_UNSUPPORTED_VERSION` | A pack of another format version (`details.version`). |
| `PACK_CORRUPT` | Truncated file; header that is not JSON, not a version 1 header, or has invalid numbers; index that does not inflate, parse, or match the header and blocks; a block that does not inflate (gzip's CRC-32 catches damaged bytes), is not valid UTF-8, does not end in a newline, holds a line that is not JSON or not a record, or is out of order (`details.block`). |
| `PACK_READ_FAILED` | The `ByteSource` failed or returned fewer bytes than asked (`details.cause`). Not cached, so a later lookup retries. |

A block that fails is not cached; other blocks keep working. The whole file is also pinned by size and SHA-256 in the asset manifest, so corruption is normally caught before the pack is opened.

## Versioning

A change that an older reader would misread gets a new version number. Adding a header field does not. A published pack never changes; a new payload gets a new release tag and new pins.
