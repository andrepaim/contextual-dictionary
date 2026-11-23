# Licence texts shipped in the extension

The build copies these into `licenses/` of the extension, next to the texts of
the npm packages that carry their own (`@huggingface/tokenizers`, `@noble/hashes`)
and this project's `LICENSE`, `NOTICE.md` and `notices/`.

- `onnxruntime/LICENSE`, `onnxruntime/ThirdPartyNotices.txt`: ONNX Runtime 1.30.0.
  The `onnxruntime-web` npm package ships neither file, so they were taken from
  the official PyPI wheel of the same release
  (`onnxruntime-1.30.0-cp311-cp311-manylinux_2_28_x86_64.whl`, files
  `onnxruntime/LICENSE` and `onnxruntime/ThirdPartyNotices.txt`). Replace them
  when `onnxruntime-web` is upgraded.
