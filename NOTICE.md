# Third-party notices

Contextual Dictionary's own code is under the MIT licence (see `LICENSE`). It uses the following works, each under its own terms.

| Work | Use | Licence |
| --- | --- | --- |
| [Wiktionary](https://en.wiktionary.org/) (English), by the Wiktionary contributors, via the [Kaikki.org](https://kaikki.org/) machine-readable extract made with [wiktextract](https://github.com/tatuylonen/wiktextract), snapshot of 2026-10-30 | Definitions and examples in the dictionary pack `wiktionary-en-v1.pack` | CC BY-SA 4.0 (Wiktionary's text is also under the GFDL). The pack is a derived work, distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). |
| [sign/Ettin-150m-WSD](https://huggingface.co/sign/Ettin-150m-WSD/tree/8751b577199d1bb95b74fa2457da7065d57100ae) by sign (Nagish Inc.), revision `8751b577199d1bb95b74fa2457da7065d57100ae`, exported to dynamic INT8 ONNX with the compact-v1 inference contract | Orders meanings by context (`ettin-150m-wsd-int8.onnx.gz` and four small model files) | Apache-2.0 |
| [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m) by the Ettin authors (copyright Johns Hopkins University Center for Language and Speech Processing) | Base model of the checkpoint above | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | Runs the model in the browser | MIT |
| [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) | Tokenises prompts | Apache-2.0 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Verifies downloads | MIT |

The model and the dictionary pack are not part of this repository. They are published as the release [`assets-v1`](https://github.com/andrepaim/contextual-dictionary/releases/tag/assets-v1), next to two notices that are also in this repository:

- [`notices/NOTICES-dictionary.txt`](notices/NOTICES-dictionary.txt): the source and snapshot, attribution to the Wiktionary contributors and Kaikki.org (with the citation Kaikki.org asks for), what was changed, and the CC BY-SA 4.0 legal code.
- [`notices/NOTICES-model.txt`](notices/NOTICES-model.txt): the checkpoint and its revision, the base model, what was changed, and the Apache-2.0 and MIT licence texts.

`docs/assets.md` lists every published file with its size and SHA-256.
