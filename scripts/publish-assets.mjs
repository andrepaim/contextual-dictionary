#!/usr/bin/env node
// Publishes the model and dictionary files as the GitHub release named by
// src/assets/manifest.ts, once. Run from a maintainer machine
// that holds the inputs, after `npm ci`, with `gh` signed in:
//
//   node scripts/publish-assets.mjs --fetch-model # only download and check the model files into the cache
//   node scripts/publish-assets.mjs --dry-run     # verify, stage, print pins and notes
//   node scripts/publish-assets.mjs               # the same, then publish and verify
//
// The model files come from the Hugging Face repository and full commit of
// MODEL_SOURCE in scripts/assets-release.ts (the one for the manifest's tag),
// downloaded into a cache and checked against the manifest's stored pins.
//
// Options: --hf-repo=<owner/name> --hf-revision=<40-hex commit>   another Hugging Face source
//          --hf-cache=<directory> (default ~/.cache/contextual-dictionary/hf-models)
//          --model-dir=<export>   a local model export instead (onnx/model.int8.onnx and the JSON files)
//          --pack=<file>          (default ~/.cache/contextual-dictionary/packs/wiktionary-en-v1.pack)
//          --pack-sha256=<hex> --pack-size=<bytes>   (default: docs/dictionary-stats.json)
//          --out=<directory>      stage there instead of a new ~/.cache/contextual-dictionary/publish-<tag>-*
//                                 (not /tmp: gh installed as a snap cannot read it)
//          --keep                 keep that new staging directory
//
// Refuses a tag that already exists: published assets never change. The
// logic lives in scripts/assets-release.ts, loaded with tsx (a dev
// dependency) because it shares the pins in src/assets/manifest.ts.
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const { main, defaultDeps } = await tsImport('./assets-release.ts', import.meta.url)
process.exitCode = await main(process.argv.slice(2), defaultDeps(fileURLToPath(new URL('../', import.meta.url))))
