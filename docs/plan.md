# Contextual Dictionary: implementation plan

A Chrome extension that defines a word you select on any web page and lists the meaning that fits the passage first. Definitions come from a bundled English Wiktionary. The order comes from a local word-sense model (Ettin-150m-WSD, INT8 ONNX) running in the browser on the CPU. Nothing you read leaves the computer.

This is a port of pdfpal's "Order by context" feature (`~/src/pdfpal-ettin-definition-order`, guide `docs/contextual-definitions.md` there) to a standalone extension with a larger dictionary.

## 1. Goals and non-goals

**Goals**

1. Double-click a word, or select a short phrase, on any ordinary web page: a card shows its Wiktionary entries.
2. With the model installed and the setting on, the meanings inside each entry are listed by contextual fit. Entries keep dictionary order; no definition or example is dropped; the card shows no scores.
3. Everything runs locally. The only network use is one confirmed download of the model and the dictionary.
4. Lookups fail open: any problem leaves dictionary order.
5. Works offline after the download.

**Non-goals (v1)**

- Languages other than English, for definitions or passages.
- Chrome's built-in PDF viewer, `chrome://` pages and the Web Store (content scripts cannot run there).
- Firefox and Safari.
- Publishing to the Chrome Web Store (needs the owner's developer account; the release ZIP is prepared for it).
- Accounts, sync, telemetry, AI explanations.

## 2. Measured facts this plan rests on

| Fact | Value | Source |
| --- | --- | --- |
| Model on disk / compressed | 267 MB / about 150 MB | pdfpal pins, `onnx/model.int8.onnx` |
| Native warm latency | 35–55 ms for 6–11 meanings, 135–150 ms for 21–22, about 240 ms for 40 | pdfpal guide, 8 threads |
| Model limits | 127 candidates, 2,048 tokens | `model_metadata.json` |
| English Wiktionary (Kaikki extract, 2026-10-30) | 1,497,828 entries, 1,793,713 meanings | measured |
| Inflection-only entries | 536,678 | measured |
| Proper-name entries | 202,346 | measured |
| Meanings per spelling | p90 2, p99 8, p99.9 25, max 157 ("run" 117, "set" 97) | measured |
| Trimmed dictionary, definitions and two short examples | 186–234 MB as SQLite, 80–95 MB gzip | measured |
| Live Wiktionary lookup | 14 ms cached, 343 ms p50 uncached, rate-limited after about 10 uncached lookups | measured; reason for bundling |

**Unproven, validated in stage 3:** inference speed under WebAssembly, and ranking accuracy on Wiktionary definitions (the model was trained on WordNet glosses).

## 3. Product decisions

| Topic | Decision |
| --- | --- |
| Dictionary scope | Every part of speech except proper names (`name`) and single characters/symbols. Inflections are stored as pointers to their base word. Up to two examples per meaning, each at most 240 characters, usage examples before quotations. The builder takes these as options. |
| Dictionary storage | A custom block-compressed "pack" (section 5.2), about the gzip size on disk, read by byte range. No SQLite in the browser. |
| Trigger | Double-click, or a selection of at most 4 words and 80 characters containing a letter. Never inside inputs, textareas, `contenteditable` or password fields. |
| Card | Shadow DOM, positioned near the selection, keyboard dismiss (Escape), "Show all meanings", attribution line "Wiktionary, CC BY-SA 4.0" with a link to the entry. |
| Render policy | One final render. A lightweight placeholder appears at once; the card renders when the order is known or the budget ends, whichever is first. A late answer is cached for the next lookup of the same passage and never reorders a visible card. |
| Budget | Default 350 ms for a ready model, configurable 50–2000 ms. Revisit with stage 3 numbers. |
| Candidates | All meanings are offered when they fit. Above `maxCandidates` (default 48, revisit in stage 3) or the token limit, only the first meanings in dictionary order are scored; the rest keep their order after the scored ones. |
| Ordering policy | Same as pdfpal: stable sort inside each entry; dictionary order on "none of the above" win or tie, single-meaning entries, non-English passage, unsafe text (`*`, control tokens), failure or timeout. |
| Opt-in | Definitions work as soon as the dictionary is installed. "Order by context" is a separate switch. Each download shows its size and starts only after confirmation. |
| Sites | Works on all sites by default with a per-site off switch in the popup. |
| Assets | Published as a GitHub release `assets-v1` of this repository: `ettin-150m-wsd-int8.onnx.gz`, the small model files, `wiktionary-en-v1.pack`, and notices. Every file is pinned by size and SHA-256 in `src/assets/manifest.ts`. Published assets are never changed; a new payload gets a new tag. |
| Licenses | Code MIT. Dictionary pack CC BY-SA 4.0 (Wiktionary). Model Apache-2.0 (base MIT). ONNX Runtime MIT. Notices ship in the extension and next to the assets. |
| Privacy | No telemetry. Lookups, selections and context never leave the extension. The answer cache holds prompt hashes and numbers only. |

## 4. Architecture

```
web page ── content script ──┐  selection, context, card (shadow DOM)
popup ───────────────────────┤  switches, download consent, progress
                             ▼
                   service worker (ephemeral)
                   settings in chrome.storage.local, message router,
                   creates the offscreen document on demand
                             ▼
                   offscreen document (long-lived)
                   ├─ asset service: download, verify, OPFS
                   ├─ dictionary: pack reader + lookup
                   ├─ ranker: budget, queue, cache
                   └─ Web Worker: tokenizer + onnxruntime-web (WASM, threads)
```

- The service worker can be stopped at any time, so it holds no model, no download and no cache.
- The offscreen document is cross-origin isolated (`cross_origin_embedder_policy` and `cross_origin_opener_policy` in the manifest) so WebAssembly threads work.
- Extension pages use `script-src 'self' 'wasm-unsafe-eval'`. No remote code.
- Permissions: `storage`, `offscreen`, `unlimitedStorage`; content script on `<all_urls>`; host permissions for the release download hosts only.

### Source layout and ownership

| Path | Contents | Stage 1 owner |
| --- | --- | --- |
| `src/shared/contracts.ts` | Types and message protocol shared by every module | coordinator (change by small PR, never silently) |
| `src/sense/` | Prompt building, offsets, English check, reorder, ranker (budget, queue, cache) | task A |
| `src/dict/`, `scripts/build-dictionary.ts` | Pack format, writer, reader, lookup, builder CLI | task B |
| `src/model/` | Inference session, Web Worker, worker client | task C |
| `src/assets/` | Pins, OPFS file store, download and verification, asset service | task D |
| `src/content/`, `src/popup/` | Selection, card, controller, popup view | task E |
| `src/background/`, `src/offscreen/`, `test/e2e/`, release | Wiring, end-to-end tests, packaging | task F |

Files named `*.entry.ts` contain wiring only and are excluded from coverage. Everything else is unit-tested.

## 5. Module specifications

### 5.1 Sense (`src/sense/`), ported from pdfpal

- `prompt.ts`: `codePointSpan`, `looksEnglish`, `senseRequest`, `contextualOrder` ported from `src/core/sense-order.ts` with its tests. Adds the candidate cap (decision above): the request records which meanings were scored; unscored meanings keep their relative order after the scored ones of the same entry.
- `ranker.ts`: port of `src/core/contextual-definitions.ts` on top of the `WorkerLike` contract: states `idle | loading | ready | failed | closed`, background warm-up, latest-wins queue with one prompt in flight, per-lookup budget, abort signal, late-answer LRU cache keyed by the SHA-256 of the prompt, load and run watchdogs, retry pause after failure, `close()`.

### 5.2 Dictionary (`src/dict/`)

**Pack format v1** (single file, little-endian):

```
magic "CDPK" | u32 version | u32 headerLength | header JSON (UTF-8)
blocks…                         each block: gzip of newline-separated JSON records, sorted by key
index                           gzip of JSON: [{ firstKey, offset, length }]
```

The header holds `{ version, language, source, license, createdFrom, snapshot, entryCount, senseCount, blockCount, indexOffset, indexLength }`. Records are `{ k, e?, f? }`: `k` is the lookup key (NFC, lower-case), `e` the entries `[{ w, p, s: [definition | [definition, ...examples]] }]` with the original spelling `w` and part of speech `p`, and `f` the inflection pointers `[{ p, l }]` to a base word `l`. Target block size is 64 KB before compression.

- `pack-writer.ts` (Node): streams sorted records into blocks. `pack-reader.ts`: opens a `ByteSource`, reads header and index once, then `get(key)` reads and inflates one block (`DecompressionStream` in the browser, the same API in Node 22). A small LRU keeps recent blocks.
- `lookup.ts`: `define(selection)` returns a `DictionaryResult`. Order of attempts: the longest compound around the selection found in the dictionary (up to 4 words, using `before`/`after`), the exact spelling, lower-case, inflection pointers (the card shows the base word's entries, the inflection note first), then simple English suffix stripping as a last resort. Unknown words return no entries.
- `scripts/build-dictionary.ts`: reads a Kaikki `jsonl.gz`, applies the scope decisions, sorts by key with bounded memory (external merge or SQLite scratch file), writes the pack and a `stats.json` (counts, sizes, meanings-per-key percentiles, largest keys). Strips wiki markup left in glosses. Deterministic: the same input gives a byte-identical pack.

### 5.3 Model (`src/model/`)

- `session.ts`: given the model bytes, tokenizer JSON and metadata, creates the ONNX session and answers `logits(prompt)`: tokenise, refuse more than `max_length` tokens (`TOO_LONG`) or a mask count other than one (`MASK`), run with `input_ids`, `attention_mask`, `prediction_positions` (int64), return the first 128 logits. Takes the ONNX and tokenizer modules by injection so tests use fakes.
- `worker.entry.ts`: the Web Worker. Protocol (same as pdfpal): in `{type:'load', ...}`, `{type:'score', id, prompt}`, `{type:'close'}`; out `{type:'ready', format}`, `{type:'failed', code}`, `{type:'scored', id, logits}`, `{type:'rejected', id, code}`. Verifies metadata (`template_version` `compact-v1`, pinned revision), runs two warm-up prompts before `ready`.
- Runtime: `onnxruntime-web` 1.30.0, WASM execution provider, SIMD, threads = half the logical cores, at most 8. The `.wasm` and `.mjs` runtime files are copied into the extension by the build. `@huggingface/tokenizers` 0.2.0.

### 5.4 Assets (`src/assets/`)

- `manifest.ts`: release tag and, per file, `{ name, url, size, sha256, storedName, storedSize, storedSha256, encoding: 'identity' | 'gzip' }`, grouped into the bundles `dictionary` and `model`.
- `file-store.ts`: `FileStore` over the origin private file system, plus an in-memory implementation for tests. Writes go to a temporary name and are moved into place only after verification.
- `download.ts`: streaming fetch with progress, a stall timer, an abort signal, incremental SHA-256 of the transferred bytes (`@noble/hashes`), size limit enforcement, optional gunzip, incremental SHA-256 of the stored bytes. Coded errors: `DOWNLOAD_FAILED`, `DOWNLOAD_STALLED`, `DOWNLOAD_CANCELLED`, `ASSET_CORRUPT`, `ASSET_MISMATCH`, `DISK_FULL`, `INSTALL_FAILED`.
- `service.ts`: per bundle `missing | downloading | installing | ready | failed`, `startDownload(bundle, acceptBytes)` (refused with `DOWNLOAD_SIZE_CHANGED` when the size differs from what was shown), `cancel`, verification of stored files on first use in a session, repair of a file that no longer matches.

### 5.5 Content script and popup (`src/content/`, `src/popup/`)

- `selection.ts`: `isDefinable`, and `selectionContext(range)`: up to 120 characters before and after within the nearest block-level ancestor, with whitespace collapsed, ignoring hidden nodes, scripts and styles.
- `card.ts`: renders the placeholder, the card and the error-free empty state (no card for unknown words). Accessible names, focus management, light and dark themes, no page CSS leaks in or out.
- `controller.ts`: listens for `mouseup`/`dblclick`/`selectionchange`, de-duplicates the two clicks of a double-click, cancels a superseded lookup, drops late answers, honours the per-site switch.
- `popup.ts`: definitions on/off, order by context on/off, this-site on/off, download consent with the exact size, progress bar, cancel, retry, coded error messages, storage used, "Remove downloaded files".

### 5.6 Wiring (`src/background/`, `src/offscreen/`)

- Service worker: settings, per-site list, message router, offscreen lifecycle (create on first need, recreate after a crash).
- Offscreen host: owns the asset service, dictionary, ranker and worker; answers `define`, `status`, `download`, `cancel`, `remove`.

## 6. Stages and tasks

Every task is done with test-driven development: a failing test is committed before the code that makes it pass, and the pull request shows that order. Each task is one branch and one pull request into `main`, merged by squash once CI is green.

### Stage 0: foundation (coordinator)

Repository, this plan, `CLAUDE.md`, shared contracts, build, unit and end-to-end harness, CI. **Done when** CI is green on `main`.

### Stage 1: modules (five agents in parallel)

| Task | Scope | Done when |
| --- | --- | --- |
| A. Sense | Section 5.1 | pdfpal's `sense-order` and `contextual-definitions` test cases pass in their ported form; new tests cover the candidate cap; ranker tests use a fake worker for budget, late cache, supersede, cancel, crash, stuck prompt, close. |
| B. Dictionary | Section 5.2 | Round-trip tests (write then read) on fixture records; reader tests for missing keys, block boundaries, corrupt header/index/block; lookup tests for case, inflections, compounds, unknown words; builder test on a fixture extract is deterministic; a real build from the cached Kaikki file completes and `stats.json` is committed under `docs/`. |
| C. Model | Section 5.3 | Session tests with fake ONNX and tokenizer modules cover tensors, mask position, too-long and no-mask prompts, short outputs; worker protocol tests; an opt-in test (`CD_TEST_MODEL_DIR`) loads the real model with `onnxruntime-web` and orders "mouse" and "bank" by context. |
| D. Assets | Section 5.4 | Tests with a mocked `fetch` and the in-memory store cover progress, truncation, oversize, digest mismatch, HTTP errors, stall, cancel, disk full, gunzip, atomic install, reuse without network, tampered stored file and repair, size-changed refusal. |
| E. Card and popup | Section 5.5 | DOM tests cover definable selections, context extraction across inline elements and line breaks, editable fields ignored, card rendering and "Show all", Escape and outside click, double-click sends one lookup, superseded lookups cancelled, late answers dropped, popup states for every asset and setting state. |

### Stage 2: integration and assets (two agents in parallel)

| Task | Scope | Done when |
| --- | --- | --- |
| F. Wiring and end-to-end | Section 5.6; Playwright tests with the built extension, a fixture page, a tiny pack, a fake model worker and a local asset server; reproducible ZIP; `release.yml` | End-to-end tests pass in CI: card appears on double-click, order changes with the setting, placeholder then one render, download flow with size confirmation, progress, cancel, failure and retry, per-site off, offscreen recreated after being closed, extension works after a service-worker restart. Two builds of the same commit give the same ZIP hash. |
| G. Real assets | Build the real pack; publish release `assets-v1` (pack, model files, notices); pin sizes and digests in `src/assets/manifest.ts`; `scripts/publish-assets.mjs` that refuses to overwrite an existing tag | Published files download anonymously and match their pins; an opt-in test downloads them into a temporary store and verifies every file; `NOTICE.md` and the notices in the release are complete. |

### Stage 3: validation and release (one agent)

| Task | Scope | Done when |
| --- | --- | --- |
| H. Validation | Real model and real dictionary inside Chromium: cold load time, warm latency by number of candidates (p50, p90, p99), memory; accuracy on a labelled set of at least 100 passages with Wiktionary meanings (reuse the pdfpal pilot passages in `~/src/sense-model/data/pilot` where they apply), comparing dictionary order with model order, first meaning and top three; tune `budgetMs` and `maxCandidates` from the numbers; `docs/validation.md` with method, numbers and limits; README, privacy statement, user guide; tag `v0.1.0` | The report states measured numbers and how labels were made. Model order is at least as good as dictionary order on the labelled set, or the report says plainly that it is not and the default for "Order by context" stays off with the finding recorded. `v0.1.0` release holds the extension ZIP built by CI. A manual check of the unpacked extension on three real sites is recorded. |

## 7. Validation matrix

| Layer | Tool | Runs in CI | What it proves |
| --- | --- | --- | --- |
| Types | `tsc --noEmit` (strict) | yes | Contracts are honoured across modules |
| Unit | Vitest, happy-dom, coverage thresholds 85% lines / 80% branches | yes | Module behaviour, every fallback path |
| Build | esbuild script, manifest check | yes | The extension builds; manifest is valid MV3; no remote code |
| End to end | Playwright with the built extension, fakes for model and assets | yes | The pieces work together in Chromium |
| Package | Reproducible ZIP hash, size budget for the ZIP (under 30 MB) | yes | Release artefact is deterministic |
| Real model | Opt-in (`CD_TEST_MODEL_DIR`) | no (local, stage 3) | The real checkpoint runs under WebAssembly and orders by context |
| Real assets | Opt-in (`CD_TEST_REAL_ASSETS=1`) | no (local, stage 2/3) | Published files match their pins |
| Performance and accuracy | Stage 3 scripts, results in `docs/validation.md` | no | The two unproven assumptions |
| Secrets | `scripts/check-secrets.mjs` | yes | No keys or tokens are committed |

Tests never touch the network or a real model unless an opt-in variable is set.

## 8. CI/CD

- `ci.yml`, on pull requests and pushes to `main`: install, secret scan, typecheck, unit tests with coverage, build, package check, Playwright end-to-end. Uploads the built ZIP as a workflow artefact.
- `release.yml`, on a `v*` tag: the same checks, then a GitHub release with `contextual-dictionary-<version>.zip` and `SHA256SUMS.txt`. The tag must equal the manifest version.
- Assets are published by `scripts/publish-assets.mjs` from a maintainer machine (the model export and the Kaikki extract are local inputs), not by CI.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| WebAssembly is too slow for the budget | Placeholder plus one render; candidate cap; late-answer cache; stage 3 tunes defaults from measurements; WebGPU with the float model is a later option. |
| The model ranks Wiktionary definitions poorly | Stage 3 measures it before anything is promoted; "none of the above" keeps dictionary order; the ordering switch is separate and can ship off. |
| Words with 100+ meanings | Candidate cap in dictionary order; measured in stage 3. |
| Release download blocked by CORS or redirects | Host permissions for the release hosts; opt-in real download test in Chromium in stage 2. |
| Storage eviction or quota | `unlimitedStorage`; verification on first use each session; repair path. |
| Memory of a 267 MB model in a hidden page | Measured in stage 3; the model unloads after an idle period (default 10 minutes) and reloads on demand. |
| Web Store review of `<all_urls>` | Out of scope for v1; the privacy statement and single-purpose description are written in stage 3. |
| Wiktionary markup or odd entries | Builder strips markup and has fixture tests for templates, empty glosses and form-of chains. |

## 10. Definition of done for v0.1.0

1. All tasks A–H merged, CI green on `main`.
2. A fresh Chrome profile with the release ZIP: confirm both downloads, double-click "mouse" in "Drag the mouse to move the cursor on screen" and the pointing-device meaning is first; turn ordering off and dictionary order returns; go offline and lookups still work.
3. `docs/validation.md` reports measured latency and accuracy with their limits.
4. Attribution and licences are visible in the card, the popup and the release.
