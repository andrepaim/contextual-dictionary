# Release assets

The extension downloads its dictionary and its model from one GitHub release of this repository (`assets-v2` from this version on; `assets-v1` before), once, after the reader confirms each download. Every file is pinned by size and SHA-256 in `src/assets/manifest.ts`, and the extension checks them while they arrive (`src/assets/download.ts`) and again in the background after their first use in each session (`src/assets/service.ts`; a lookup does not wait for it, see `docs/validation.md`). Published assets never change: a new payload gets a new tag and new pins.

## assets-v2 (prepared, not yet published)

The model fine-tuned on English Wiktionary in training round 1 (`docs/validation.md`, "Training round 1"). `src/assets/manifest.ts` names `assets-v2`; until that release is published, downloads of both bundles fail, so the release must exist before this manifest is on `main`. Files download from `https://github.com/andrepaim/contextual-dictionary/releases/download/assets-v2/<file>`.

| File | Bundle | What it is | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `wiktionary-en-v1.pack` | dictionary | The same pack as in `assets-v1`, byte for byte (the release tag applies to every download, so the release carries it again). | 66,467,698 | `e698a7117d4a684d554c1c5850674ed9035c2daab7dbd8125c6c63758b6e6c32` |
| `ettin-150m-wsd-int8.onnx.gz` | model | The fine-tuned checkpoint (revision `sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3`), INT8 ONNX with the MatMul of the feed-forward output in layers 4, 7, 9, 11 and 15 in float and the token embedding in float16, gzip level 9. Stored gunzipped as `ettin-150m-wsd-int8.onnx`: 203,516,610 bytes, SHA-256 `6bac203419a0ad43b09b3806c22abb4870c48adf21657f3ef2a73a5d8369d6e4`. | 185,262,587 | `fdacbedebc3354331742f98e6ed24b3455b78c187d5606c345640bdccc752c2f` |
| `model_metadata.json` | model | Inference metadata (as before) with the fine-tuned revision, the base checkpoint and its revision, the teacher, the training data and the export | 3,052 | `75a45b7a19fb743ebfaf7716f1eb29fdb02fb25971e1e7959caac6e139a72abc` |
| `calibration.json` | model | The same file as in `assets-v1` | 101 | `84f67365897b09a6d6b7d2289f16dd6582d07e7e6e0f1b2094491a72b636d8ab` |
| `tokenizer.json` | model | The same file as in `assets-v1` (the checkpoint's tokenizer is unchanged) | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `tokenizer_config.json` | model | The same file as in `assets-v1` | 487 | `d0ec2c8141eec0fa98e31a43c3a453f9c40dcde862762762b0f1898bfb793183` |
| `NOTICES-model.txt` | – | Model notices: the base checkpoint, the teacher, the training data and their licences, with the Apache-2.0 and MIT texts | | |
| `NOTICES-dictionary.txt` | – | As in `assets-v1` | 23,850 | `b107fc851a5cad95af090f8c23dca2385bd185f1e205c531cadac44a5dd1cda1` |

The model bundle transfers 188.8 MB (147.0 MB before) and is stored in 207.1 MB (270.5 MB before); with the dictionary, 273.6 MB stored.

**An extension that already has `assets-v1` installed.** The graph and the metadata keep their stored names and get new pins. On the first status check after the update the asset service finds both at a size other than the pinned one and removes them (`inspect` in `src/assets/service.ts`), so the old 267 MB graph is deleted at once and nothing is left behind. The model bundle then shows as not installed: the extension's window says "Needs a one-time download of 185.3 MB." next to a "Download" button (the graph and the metadata; the calibration and tokenizer files match their pins and are kept), and until the reader confirms it, cards keep dictionary order (with "Show order details" on, their status line says "Dictionary order · context model not installed"). The dictionary pack matches its pins, so it is kept and not downloaded again.

**How it was staged.** `python3 -I validation/training/release_model_dir.py` assembled the model export (the graph from the export of the chosen run, the metadata with its revision and provenance, the calibration and tokenizer files copied from `assets-v1`'s export), then `node scripts/publish-assets.mjs --dry-run --model-dir=<that folder>` staged the release and printed the pins above; the transfer pins of the graph were copied from that run. The staged graph unpacks to the pinned graph. A second dry run of `assets-v1` with the unchanged script staged every published file of `assets-v1` byte for byte.

## What was published in assets-v1

Release [`assets-v1`](https://github.com/andrepaim/contextual-dictionary/releases/tag/assets-v1), "Dictionary pack and model files v1", published on 2026-11-23 as a prerelease, so it is never the repository's "latest" release. Tag `assets-v1` points at `c14220d` on `main`. Files download from `https://github.com/andrepaim/contextual-dictionary/releases/download/assets-v1/<file>`.

| File | Bundle | What it is | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `wiktionary-en-v1.pack` | dictionary | English Wiktionary pack, format v1 (`docs/pack-format.md`), built from the Kaikki.org extract of 2026-10-30 (`docs/dictionary-build.md`). Stored as is. | 66,467,698 | `e698a7117d4a684d554c1c5850674ed9035c2daab7dbd8125c6c63758b6e6c32` |
| `ettin-150m-wsd-int8.onnx.gz` | model | Ettin-150m-WSD, dynamic INT8 ONNX, gzip level 9. Stored gunzipped as `ettin-150m-wsd-int8.onnx`: 266,954,889 bytes, SHA-256 `8649a1139b81a56b16ec6853d6127882a1b9539a4c33c09e3fce93ab62822d68`. | 143,435,614 | `e90034c01d6f2431b8af5b07c2af2d046ae3c84f7d71d54e63c02b32509205f4` |
| `model_metadata.json` | model | Inference metadata: answer letters, template `compact-v1`, maximum length, checkpoint revision | 1,552 | `7a07cdd82572cada84061c1cdb61670b2d220d9cc422397d18244874d9fb7707` |
| `calibration.json` | model | Calibration settings (identity, "uncalibrated") | 101 | `84f67365897b09a6d6b7d2289f16dd6582d07e7e6e0f1b2094491a72b636d8ab` |
| `tokenizer.json` | model | Tokenizer | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `tokenizer_config.json` | model | Tokenizer configuration | 487 | `d0ec2c8141eec0fa98e31a43c3a453f9c40dcde862762762b0f1898bfb793183` |
| `NOTICES-model.txt` | – | Model notices with the Apache-2.0 and MIT texts (same as `notices/NOTICES-model.txt`) | 15,333 | `ff2f98d606675da048198b254b0a56dd4a0a5a19eab6a67933e4e108aa7a6ffe` |
| `NOTICES-dictionary.txt` | – | Dictionary notices with the CC BY-SA 4.0 legal code (same as `notices/NOTICES-dictionary.txt`) | 23,850 | `b107fc851a5cad95af090f8c23dca2385bd185f1e205c531cadac44a5dd1cda1` |

The dictionary bundle transfers 66.5 MB and the model bundle 147.0 MB; stored, the two take 337 MB. The extension does not download the notices.

The gzip of the graph is deterministic: the header has no file name, a zero time and OS byte 255, so staging twice gives the same bytes (checked with two dry runs before publishing). It was made with the zlib bundled in Node v22.23.1; another zlib could compress differently, which is one more reason the published file, not a rebuild, is what the pins describe.

## Licences

| File | Licence | Attribution |
| --- | --- | --- |
| `wiktionary-en-v1.pack` | CC BY-SA 4.0 (Wiktionary's text is dual-licensed CC BY-SA 4.0 and GFDL; the pack is a derived work distributed under CC BY-SA 4.0) | Wiktionary contributors, through Kaikki.org (wiktextract). The changes are listed in `NOTICES-dictionary.txt`. |
| The five model files of `assets-v2` | Apache-2.0, as the checkpoint they were fine-tuned from ([sign/Ettin-150m-WSD](https://huggingface.co/sign/Ettin-150m-WSD/tree/8751b577199d1bb95b74fa2457da7065d57100ae), revision `8751b577199d1bb95b74fa2457da7065d57100ae`) | Fine-tuned by this project on English Wiktionary examples (CC BY-SA 4.0 and GFDL) with soft labels from [sign/Ettin-1B-WSD](https://huggingface.co/sign/Ettin-1B-WSD/tree/e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc) (Apache-2.0) on those and on English Wikipedia paragraphs (CC BY-SA 3.0 and GFDL); base model [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m), MIT; see `NOTICES-model.txt`. |
| The five model files of `assets-v1` | Apache-2.0 (checkpoint [sign/Ettin-150m-WSD](https://huggingface.co/sign/Ettin-150m-WSD/tree/8751b577199d1bb95b74fa2457da7065d57100ae), revision `8751b577199d1bb95b74fa2457da7065d57100ae`) | Base model [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m), MIT. Exported to dynamic INT8 ONNX with the compact-v1 inference contract; see `NOTICES-model.txt` of `assets-v1`. |

Each notice holds its licence texts verbatim: the Apache License 2.0 as published at https://www.apache.org/licenses/LICENSE-2.0.txt, the MIT licence of the Ettin repository (https://github.com/jhu-clsp/ettin-encoder-vs-decoder), and the CC BY-SA 4.0 legal code from https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt. `test/unit/assets/notices.test.ts` checks the Apache and CC texts by their SHA-256.

## Verify a download by hand

```bash
base=https://github.com/andrepaim/contextual-dictionary/releases/download/assets-v1
curl -fLO "$base/wiktionary-en-v1.pack"
curl -fLO "$base/ettin-150m-wsd-int8.onnx.gz"
sha256sum wiktionary-en-v1.pack ettin-150m-wsd-int8.onnx.gz   # compare with the table above
gunzip -c ettin-150m-wsd-int8.onnx.gz | sha256sum             # 8649a113…2d68, the stored graph
```

The whole release, through the extension's own download code, with the real `fetch` into memory (about 340 MB of memory, 214 MB of transfer):

```bash
CD_TEST_REAL_ASSETS=1 npx vitest run test/unit/assets/real-assets.test.ts --silent=false
```

On 2026-11-23 this took 21 s on the maintainer's connection (about 10 MB/s): the dictionary in 6.4 s, the model in 14.2 s. Both bundles ended `ready` and passed `verify`.

## Download hosts

Observed on 2026-11-23, for every file of the release, with no credentials:

1. `GET https://github.com/andrepaim/contextual-dictionary/releases/download/assets-v1/<file>` answers **302**, `content-length: 0`, `cache-control: no-cache`, with `location: https://release-assets.githubusercontent.com/github-production-release-asset/1468753661/<asset id>?<signed query>`. The query is a signed, expiring token (`se` was about 40 minutes ahead; keys `sp sv sr spr se rscd rsct skoid sktid skt ske sks skv sig jwt response-content-disposition response-content-type`), so the full URL changes on every request; the host and the path prefix `/github-production-release-asset/<repository id>/` stay the same.
2. `GET` of that URL answers **200** from Azure Blob storage behind Varnish (`server: Windows-Azure-Blob/1.0`), `content-type: application/octet-stream`, `content-disposition: attachment; filename=<file>`, the exact `content-length`, `accept-ranges: bytes`.

Neither hop sends `access-control-allow-origin` or `cross-origin-resource-policy`, with or without an `Origin: chrome-extension://…` request header, and a CORS preflight (`OPTIONS`) is refused (404 on github.com, 405 on the blob host). So an extension page can read these responses only because the hosts are in its `host_permissions`, which exempts its requests from CORS. The download is a simple `GET` with no custom headers, so no preflight is needed.

`src/manifest.json` therefore grants exactly these two hosts:

- `host_permissions`: `https://github.com/andrepaim/contextual-dictionary/releases/download/*` and `https://release-assets.githubusercontent.com/*`.
- `connect-src` of the extension pages' policy: `'self' https://github.com/andrepaim/contextual-dictionary/releases/download/ https://release-assets.githubusercontent.com`. CSP Level 3 ignores the path of a source after a redirect, so the blob host needs no path.

`test/unit/assets/download-hosts.test.ts` checks that both lists cover every release URL of the manifest and the observed redirect, and nothing else.

Two things are not settled by observation alone and are for the in-browser download check in a later stage: whether the offscreen document, which is cross-origin isolated (`cross_origin_embedder_policy: require-corp`), can read a response that carries no `cross-origin-resource-policy` (expected, because `fetch` makes a CORS-mode request, which COEP does not block, but not yet seen in Chrome), and whether GitHub keeps this redirect host. GitHub used to redirect release downloads to `objects.githubusercontent.com`; if the host changes again, downloads fail with `DOWNLOAD_FAILED` until a build adds the new one.

## Publish a new release

`scripts/publish-assets.mjs` publishes the release that `src/assets/manifest.ts` names, once. For a new payload (a new pack, a new model export):

1. Build or obtain the new inputs (for `assets-v2`, see above). A new pack's pins go in `docs/dictionary-stats.json` (the builder writes them). A file whose format changes gets a new name (for example `wiktionary-en-v2.pack`); then update `STORED_NAMES` and the source mapping in `scripts/assets-release.ts` (`sources()`, `MODEL_EXPORT_PATHS`).
2. In `src/assets/manifest.ts`, set `tag: 'assets-v2'`, change the file names that changed, set the stored pins of the new model files, and set every transfer pin of a changed file to `null` (the script fills nothing in; it checks the pins it finds). Update the descriptions in `scripts/assets-release.ts` if files are added, and the notices in `notices/`.
3. Dry run and read the output: the pins, the release notes, the gzip round trip.

   ```bash
   node scripts/publish-assets.mjs --dry-run
   ```

4. Copy the printed pins into the manifest (the script prints the pinned bundles as JSON), commit, and dry-run again: it now also checks the staged files against the manifest's transfer pins.
5. Publish: `node scripts/publish-assets.mjs`. It refuses when the tag or a release with it exists, uploads into a draft prerelease, checks the uploaded sizes and digests, publishes, downloads every file back without credentials and prints the redirect chain. If a check fails after publishing, do not delete or re-upload anything: a published file must never change. Publish a new tag instead.
6. Run the opt-in real-asset test, then merge the manifest change.

Keep `assets-v1` and its files: extensions already installed download from those URLs. Inputs and defaults: `--model-dir` (default `~/src/sense-model/artifacts/upstream-english`), `--pack` (default `~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack`), `--pack-sha256` and `--pack-size` (default `docs/dictionary-stats.json`), `--out` (default a new directory under `~/.cache/contextual-dictionary/`, not `/tmp`, which `gh` installed as a snap cannot read), `--keep`. The script needs `npm ci` (it loads its TypeScript logic with `tsx`) and a signed-in `gh`.

## How assets-v1 was made

- The pack was rebuilt from `~/.cache/contextual-dictionary/kaikki/english-2026-10-30.jsonl.gz` with the code on `main` (`c14220d`) on Node v22.23.1: SHA-256 `e698a711…6c32`, 66,467,698 bytes, identical to the pack recorded in `docs/dictionary-build.md` and `docs/dictionary-stats.json` (50 s, 376 MB peak memory).
- The model files were checked against the stored pins already in the manifest before staging.
- Two dry runs staged byte-identical files. The release was then published once, and every file was downloaded back anonymously by the script and again with `curl`, matching size and SHA-256.
