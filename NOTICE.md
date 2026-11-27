# Third-party notices

Contextual Dictionary's own code is under the MIT licence (see `LICENSE`). It uses the following works, each under its own terms.

| Work | Use | Licence |
| --- | --- | --- |
| [Wiktionary](https://en.wiktionary.org/) (English), by the Wiktionary contributors, via the [Kaikki.org](https://kaikki.org/) machine-readable extract made with [wiktextract](https://github.com/tatuylonen/wiktextract), snapshot of 2026-10-30 | Definitions and examples in the dictionary pack `wiktionary-en-v1.pack` | CC BY-SA 4.0 (Wiktionary's text is also under the GFDL). The pack is a derived work, distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). |
| The context model: fine-tuned by this project from the checkpoint below on English Wiktionary examples, with soft labels from Ettin-1B-WSD (training round 1, [`docs/validation.md`](docs/validation.md)), revision `sha256:49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3`, exported to INT8 ONNX with the compact-v1 inference contract; the float weights and both ONNX exports are published as [andrepaim/Ettin-150m-WSD-wiktionary](https://huggingface.co/andrepaim/Ettin-150m-WSD-wiktionary/tree/0edcbab04bb30eadeeef6babb26e8055b173b8d7) | Orders meanings by context (`ettin-150m-wsd-int8.onnx.gz` and four small model files) | Apache-2.0 |
| [sign/Ettin-150m-WSD](https://huggingface.co/sign/Ettin-150m-WSD/tree/8751b577199d1bb95b74fa2457da7065d57100ae) by sign (Nagish Inc.), revision `8751b577199d1bb95b74fa2457da7065d57100ae` | The checkpoint the context model was fine-tuned from | Apache-2.0 |
| [sign/Ettin-1B-WSD](https://huggingface.co/sign/Ettin-1B-WSD/tree/e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc) by sign (Nagish Inc.), revision `e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc` | Teacher: its answers were soft labels in the training; none of its weights are distributed | Apache-2.0 |
| English Wiktionary usage examples and quotations (Kaikki.org extract of 2026-10-30) and English Wikipedia paragraphs ([wikimedia/wikipedia](https://huggingface.co/datasets/wikimedia/wikipedia), dump of 2023-11-01) | Training data of the context model; no training text is in the extension or its release files. The examples, with the teacher's soft labels, are published as the dataset [andrepaim/wiktionary-wsd](https://huggingface.co/datasets/andrepaim/wiktionary-wsd/tree/84b6444e83219aaa76c29a517a64a640c1df9a46) | Wiktionary: CC BY-SA 4.0 and GFDL; Wikipedia: CC BY-SA 3.0 and GFDL, as stated by that dataset |
| [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m) by the Ettin authors (copyright Johns Hopkins University Center for Language and Speech Processing) | Base model of the checkpoint above | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | Runs the model in the browser | MIT |
| [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) | Tokenises prompts | Apache-2.0 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Verifies downloads | MIT |

The model and the dictionary pack are not part of this repository. They are published as the release [`assets-v2`](https://github.com/andrepaim/contextual-dictionary/releases/tag/assets-v2) (before it, [`assets-v1`](https://github.com/andrepaim/contextual-dictionary/releases/tag/assets-v1) with the checkpoint itself), next to two notices that are also in this repository:

- [`notices/NOTICES-dictionary.txt`](notices/NOTICES-dictionary.txt): the source and snapshot, attribution to the Wiktionary contributors and Kaikki.org (with the citation Kaikki.org asks for), what was changed, and the CC BY-SA 4.0 legal code.
- [`notices/NOTICES-model.txt`](notices/NOTICES-model.txt): the fine-tuned model, the checkpoint it was fine-tuned from and its base model, the teacher, the training data and their licences, what was changed, and the Apache-2.0 and MIT licence texts.

`docs/assets.md` lists every published file with its size and SHA-256.
