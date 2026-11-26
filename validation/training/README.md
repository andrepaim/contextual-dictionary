# Training round 1: scripts as run

The Python and shell scripts that made the model of `assets-v2` from the data the two TypeScript builders write
(`validation/build-train-set.ts`, `validation/build-unlabelled-set.ts`). Method, numbers and rerun commands are in
`docs/validation.md`, "Training round 1". They read and write under `~/.cache/contextual-dictionary/validation/`
(training data, checkpoints and logs there hold Wiktionary and Wikipedia text and are never committed) and use the
sense-model repository's model and loss (`~/src/sense-model/src/wsd`) without changing it. Not run in CI. The Python
environment: Python 3.12, PyTorch 2.14.1 with CUDA 13.0, transformers 5.23.0, onnx 1.23.2, onnxruntime 1.32.0,
tokenizers, pyarrow, tensorboard.

| Script | What it does |
| --- | --- |
| `wiki_paragraphs.py` | A seeded sample of prose paragraphs from one English Wikipedia parquet shard (the unlabelled stream's input). |
| `prepare_examples.py` | Turns the builders' prompts into sense-model Examples, checking that sense-model's `format_prompt` reproduces each prompt byte for byte. |
| `check_leaks.py` | The leak checks: no held-out headword, no passage equal to or overlapping a test passage, train and development headwords disjoint. |
| `score_batch.py` | Batched PyTorch scorer (teacher soft labels in bf16, every accuracy measurement in fp32), resumable. |
| `make_teacher_cache.py` | Teacher logits to sense-model's teacher cache (fingerprints, probabilities at T = 2). |
| `train_thin.py` | The trainer: sense-model's dataset, loss and trainer class, with the extension's candidate order, length-grouped batches, resume from the newest complete checkpoint and TensorBoard logs. |
| `dev_eval.py`, `compare.py` | Development and test accuracy with the rule of `analyze.ts`, and paired bootstrap intervals (2,000 resamples, seed 1). |
| `stage2.sh`, `test_analysis.sh`, `stage2_export.sh` | The driver of the three runs and their test analysis and export (watchdog-aware, resumable). |
| `act_stats_model.py`, `export_quant.py`, `screen.py` | Activation outliers per layer, ONNX export through sense-model's exporter with the quantization recipe, and INT8 against float on development prompts. |
| `release_model_dir.py` | Assembles the model export that `scripts/publish-assets.mjs` stages (the graph, metadata with revision and provenance, the unchanged small files). |
| `quiet.sh`, `threads_accuracy.py`, `bench_build.sh`, `release_server.mjs`, `mem_probe.py` | Measurement helpers: wait for a quiet machine, accuracy within the budget by threads, a measurement-only build that downloads from a loopback server (for `validation/extension-bench.ts` on an unpublished release), GPU memory of the longest batches. |
