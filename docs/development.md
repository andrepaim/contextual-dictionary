# Development

How to build, test and release Contextual Dictionary, in one place. The rules for changes (test first, entry files are wiring, privacy, untrusted input, what never to commit) are in [`CLAUDE.md`](../CLAUDE.md), and the architecture and each module's specification in [`plan.md`](plan.md); this page does not repeat them.

## Build and test

Node.js 22 or later and npm.

```bash
npm ci
npm run typecheck
npm test                         # unit tests (Vitest) with coverage thresholds
npm run build                    # the unpacked extension in dist/
npx playwright install chromium  # once
npm run test:e2e                 # builds dist/ and dist-e2e/, then runs the Playwright tests
npm run check                    # secret scan, core package check, typecheck, unit tests, build, build check
npm run package                  # reproducible package/contextual-dictionary-<version>.zip and SHA256SUMS.txt
npm run icons                    # redraws src/icons/
```

To try a build, open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose `dist/`. After a rebuild, click **Reload** on the extension. The end-to-end tests use a separate build, `dist-e2e/`, with a fake model worker, an asset manifest read from `e2e-config.json` and loopback access; the production build must contain none of it, which `npm run check:build` checks ([`CLAUDE.md`](../CLAUDE.md), "Commands").

CI (`.github/workflows/ci.yml`) runs the same checks, the package and the end-to-end tests on every pull request and every push to `main`.

## Shared dictionary core

The dictionary lookup, the pack reader and writer, prompt building and contextual ordering live in `packages/core/`, published as `@andrepaim/contextual-dictionary-core` ([its API](../packages/core/README.md)). The extension installs it from the checked-in npm tarball in `artifacts/`, the same file another project can install. To use it elsewhere, replace `COMMIT_SHA` with a full commit SHA that contains the tarball:

```sh
npm install --ignore-scripts 'https://raw.githubusercontent.com/andrepaim/contextual-dictionary/COMMIT_SHA/artifacts/contextual-dictionary-core-0.3.0.tgz'
```

After changing the core's source:

1. Bump the version in `packages/core/package.json` and run `npm run core:pack`, which writes `artifacts/contextual-dictionary-core-<version>.tgz`.
2. Point the extension's dependency in `package.json` to the new tarball and refresh the lockfile with `npm install --ignore-scripts`.
3. Commit the source, the tarball and the lockfile together.

`npm run core:check` (part of `npm run check`) rebuilds the tarball, installs it in an isolated Node project, exercises the engine and card exports, and bundles the card stylesheet as text.

## Site

`site/`, `docs/user-guide.md` and `docs/privacy.md` are published at https://andrepaim.github.io/contextual-dictionary/ by `.github/workflows/pages.yml` on every push to `main` that changes them. `npm run build:site` builds the site into `_site/`: `scripts/build-site.mjs` puts in the shared header and footer and the examples of `site/_examples.json`, and makes the guide and the privacy page from the two documents.

The pictures and the film show the real extension and are never drawn or typed by hand. After `npm run build`:

- `npx tsx validation/site-assets.ts` looks the examples up on the site's practice page and writes the extension's answers into `site/_examples.json` and the pictures into `site/images/` (`--answers-only` for the answers alone).
- `npx tsx validation/site-video.ts` records the film `site/media/contextual-dictionary.webm` and its opening picture `site/images/film.png`. It needs the ffmpeg that Playwright installs, or another one named in `CD_FFMPEG`.
- `npx tsx validation/store-assets.ts` makes the Chrome Web Store screenshots and tiles in `store/` (listing text in [`store/listing.md`](../store/listing.md)).

The three scripts use the real dictionary and model, the release the build pins, downloaded once into a browser profile under `~/.cache/contextual-dictionary/store-profile`. Captures take the fonts of the machine they run on; to render the card as Chrome on Windows does, point `FONTCONFIG_FILE` at a configuration that maps `system-ui` to Segoe UI.

## Release the extension

1. Set the new version in `package.json` and `package-lock.json`; the build copies it into the extension's manifest.
2. Push a tag `v<version>`. `.github/workflows/release.yml` runs every check and the end-to-end tests, builds the ZIP twice and requires the two to be identical, checks that the tag equals the version, and publishes a GitHub release with the ZIP and `SHA256SUMS.txt`. A release that exists already is never replaced.
3. Submit the release's ZIP to the Chrome Web Store with the text and images of [`store/listing.md`](../store/listing.md).

Run the workflow by hand for a dry run: it stops before publishing (the default). Pull requests that change the workflow or the packaging scripts run it as a dry run too.

## Release assets: the dictionary and the model

The dictionary pack and the model files are not in the repository. They are published once in a GitHub release of their own (`assets-v2` now) and pinned by size and SHA-256 in `src/assets/manifest.ts`. Published assets never change: a new pack or model gets a new tag and new pins.

- [`assets.md`](assets.md): the releases, how to verify a download by hand, and how to publish a new one with `scripts/publish-assets.mjs`.
- [`dictionary-build.md`](dictionary-build.md): building the pack from the Kaikki.org extract; [`pack-format.md`](pack-format.md): its format.

## Measurements and training

The defaults (`DEFAULT_SETTINGS`, `RANKER_DEFAULTS.maxPromptChars`, `RANKER_DEFAULTS.entryMargin`) come from measurements, and change only with new numbers.

- [`validation.md`](validation.md): speed, accuracy, memory, the choice of defaults, release acceptance and training round 1 in the extension, with how to rerun each measurement at the end. The scripts are in `validation/`; they read local inputs (listed in [`CLAUDE.md`](../CLAUDE.md), "Local inputs") or the network and never run in CI.
- Training, model-level evaluation and publishing a model live in [sense-model](https://github.com/andrepaim/sense-model) (training round 1: its [`docs/wiktionary-round1.md`](https://github.com/andrepaim/sense-model/blob/8975259/docs/wiktionary-round1.md)); the model is published on Hugging Face, [andrepaim/Ettin-150m-WSD-wiktionary](https://huggingface.co/andrepaim/Ettin-150m-WSD-wiktionary/tree/0edcbab04bb30eadeeef6babb26e8055b173b8d7), and `scripts/publish-assets.mjs` stages the release's model files from that pinned revision ([`assets.md`](assets.md)).
- [`validation/candidate-model/README.md`](../validation/candidate-model/README.md): measuring a new model export in the extension (accuracy in the browser, latency, threads, memory, the extension benchmark on an unpublished release) against the shipped model.
- [`validation/dataset/README.md`](../validation/dataset/README.md): the dataset the model was trained on, [andrepaim/wiktionary-wsd](https://huggingface.co/datasets/andrepaim/wiktionary-wsd/tree/84b6444e83219aaa76c29a517a64a640c1df9a46), built here with the extension's own lookup and prompts: how to rebuild and republish it.
