# Third-party notices

Contextual Dictionary's own code is under the MIT licence (see `LICENSE`). It uses the following works, each under its own terms.

| Work | Use | Licence |
| --- | --- | --- |
| [Wiktionary](https://en.wiktionary.org/) (English), via the [Kaikki.org](https://kaikki.org/) machine-readable extract made with wiktextract | Definitions and examples in the dictionary pack | CC BY-SA 4.0 (also GFDL). The pack is a derived work and is distributed under CC BY-SA 4.0. |
| [sign/Ettin-150m-WSD](https://huggingface.co/sign/Ettin-150m-WSD), revision `8751b577199d1bb95b74fa2457da7065d57100ae`, exported to dynamic INT8 ONNX | Orders meanings by context | Apache-2.0 |
| [jhu-clsp/ettin-encoder-150m](https://huggingface.co/jhu-clsp/ettin-encoder-150m) | Base model of the checkpoint above | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | Runs the model in the browser | MIT |
| [@huggingface/tokenizers](https://github.com/huggingface/tokenizers.js) | Tokenises prompts | Apache-2.0 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Verifies downloads | MIT |

The model and the dictionary pack are not part of this repository. They are published as release assets with their full licence texts.
