# Contextual Dictionary developer guide

A Chrome (Manifest V3) extension: select a word on any page and a card shows its English Wiktionary meanings, with the one that fits the passage first. A local word-sense model (Ettin-150m-WSD, INT8 ONNX, `onnxruntime-web` on WebAssembly) chooses the order. Nothing the reader selects leaves the computer.

**Read `docs/plan.md` before changing anything.** It holds the product decisions, the architecture, each module's specification, the tasks and their acceptance criteria.

## Stack

- Node.js 22+, TypeScript (strict), ESM, npm.
- esbuild bundles each `*.entry.ts` into `dist/` (`scripts/build.mjs`). No UI framework: the card and popup are plain DOM.
- Vitest for unit tests (happy-dom for DOM tests, opted into per file with `// @vitest-environment happy-dom`), Playwright for end-to-end tests with the built extension.
- Runtime dependencies: `onnxruntime-web` 1.30.0, `@huggingface/tokenizers` 0.2.0, `@noble/hashes`. Ask before adding another.

## Structure

- `packages/core/`: shared dictionary and selection contracts, pack reader and writer, lookup, prompt building and contextual reordering. The extension installs the checked-in npm tarball used by PDFPal.
- `src/shared/contracts.ts`: extension contracts and message protocol, with re-exports of core contracts.
- `src/sense/`: extension ranker (budget, queue, cache).
- `src/dict/`: Kaikki extract transformation. `scripts/build-dictionary.ts` builds a pack using the core writer.
- `src/model/`: inference session, the Web Worker, its client.
- `src/assets/`: pinned files, the private file store, download and verification, the asset service.
- `src/content/`, `src/popup/`: selection, card, controller, popup.
- `src/background/`, `src/offscreen/`: service worker and offscreen document wiring.
- `test/unit/` mirrors `src/`; `test/e2e/` holds Playwright tests; `test/fixtures/` holds small inputs.
- `validation/`: the stage 3 measurement scripts (evaluation sets, scoring with the real model, the real extension benchmark, release acceptance) and `validation/data/` (item lists and the hand-written set). Run by hand with local inputs or the network, never in CI; results in `docs/validation.md`. Type-checked, not counted in coverage.
- `site/`: the project site (home page, practice page, style sheet, fonts, pictures), published with GitHub Pages by `.github/workflows/pages.yml`; `scripts/build-site.mjs` puts in the shared header and footer and the examples of `site/_examples.json`, and adds the guide and the privacy page made from `docs/user-guide.md` and `docs/privacy.md`. The pictures in `site/images/` and the answers in `site/_examples.json` are captures of the real extension made by `validation/site-assets.ts`: never draw or type them by hand. No scripts and nothing loaded from other sites. `store/`: the Chrome Web Store listing text and images (`validation/store-assets.ts` makes the images).

## Commands

```bash
npm ci
npm run typecheck
npm test            # unit tests with coverage thresholds (85% lines, 80% branches)
npm run build       # unpacked extension in dist/
npm run test:e2e    # builds dist/ and the end-to-end variant dist-e2e/, then runs Playwright (npx playwright install chromium once)
npm run check       # secret scan, typecheck, unit tests, build, build check (scripts/check-build.mjs)
npm run package     # reproducible release ZIP and SHA256SUMS.txt in package/
npm run icons       # redraws src/icons/ (scripts/make-icons.mjs)
```

- Measurements (`docs/validation.md`, "How to rerun"): `npx tsx validation/build-wiktionary-set.ts`, `validation/build-simple-set.ts`, `validation/score-prompts.ts --threads 8`, `validation/analyze.ts`, `validation/extension-bench.ts`, and `validation/acceptance.ts` (downloads the real release). `validation/store-assets.ts` and `validation/site-assets.ts` remake the store's and the site's pictures from the built extension. They write under `~/.cache/contextual-dictionary/validation/`.
- End-to-end tests use `dist-e2e/` (`node scripts/build.mjs --e2e`): a fake model worker, an asset manifest read from `e2e-config.json` and loopback access, all swapped in at build time from `test/e2e/variant/`. The production build must contain none of it; `npm run check:build` fails if it does.

## Rules

- **Test first.** Write a failing test, commit it, then commit the code that makes it pass. A pull request shows that order in its commits.
- **Entry files are wiring.** `*.entry.ts` files are excluded from coverage and must hold no logic worth testing. Put logic in a plain module and test it.
- **Contracts are shared.** Do not change `src/shared/contracts.ts` inside a feature pull request unless the change is small, additive and called out in the pull request description. Never change another module's directory to make yours fit; say what you need instead.
- **No network and no real model in automated tests.** Mock `fetch`, use the in-memory file store and a fake worker. Real-model and real-asset tests run only with `CD_TEST_MODEL_DIR` or `CD_TEST_REAL_ASSETS=1`.
- **Lookups fail open.** Any problem while ordering leaves dictionary order; a lookup never fails because of the model.
- **Privacy.** Selections and their context stay inside the extension. No telemetry, no logging of page text, no remote code. The answer cache holds prompt hashes and numbers only.
- **Untrusted input.** Page text, dictionary text and messages from pages are untrusted. Render text with `textContent`, never as HTML. Validate messages with `isRequest`.
- **Published assets never change.** A new model or dictionary payload gets a new release tag and new pins.
- **Do not commit** models, packs, Kaikki extracts or anything under `.data/`, nor Wiktionary or pilot text from the evaluation sets: commit item identifiers only.
- **Defaults come from measurements.** `DEFAULT_SETTINGS` and `RANKER_DEFAULTS.maxPromptChars` were chosen in `docs/validation.md`; change them only with new numbers there.

## Working on a task

1. Work in your own git worktree and branch: `git -C ~/src/contextual-dictionary worktree add ~/src/contextual-dictionary-worktrees/<task> -b <branch> origin/main`, then `npm ci` there.
2. Keep to the directories your task owns (see the ownership table in `docs/plan.md`).
3. Before opening a pull request, rebase on `origin/main` and run `npm run check` and `npm run test:e2e`.
4. Open a pull request into `main` with `gh pr create`. Describe what was built, what was tested and anything left out. Wait for CI (`gh pr checks --watch`), fix failures, then merge with `gh pr merge --squash --delete-branch`.
5. If `main` moved and the merge conflicts, rebase and resolve; do not force-push over someone else's work.

## Local inputs (not in the repository)

- The model export: `~/src/sense-model/artifacts/upstream-english` (`model_metadata.json`, `calibration.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.int8.onnx`).
- The Kaikki English extract of 2026-10-30: `~/.cache/contextual-dictionary/kaikki/english-2026-10-30.jsonl.gz` (534 MB; SHA-256 `4d03b6cba283744756c57ff661c2c6cbfe34fcf8ff513a966576cf7d97e91a99`).
- The Kaikki Simple English Wiktionary extract as served on 2026-10-30 (`https://kaikki.org/dictionary/downloads/simple/simple-extract.jsonl.gz`, replaced in place by later extractions): `~/.cache/contextual-dictionary/kaikki/simple-english-2026-10-30.jsonl.gz` (4.7 MB; SHA-256 `79afd871e342db3b87c3f2044ed21efa312e4c4ee006814b57c4cf4536ef70a1`). Only the evaluation set of `validation/build-simple-set.ts` reads it.
- The feature this ports: `~/src/pdfpal-ettin-definition-order` (`src/core/sense-order.ts`, `contextual-definitions.ts`, `sense-worker.ts`, `sense-download.ts`, `sense-model.ts`, their tests under `test/`, and `docs/contextual-definitions.md`). Read-only: never change that repository.
