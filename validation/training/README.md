# Training round 1: what is left here

Training round 1 (the model of `assets-v2`) now lives in [sense-model](https://github.com/andrepaim/sense-model): its
method, numbers and rerun with `wsd` commands are its
[`docs/wiktionary-round1.md`](https://github.com/andrepaim/sense-model/blob/8975259/docs/wiktionary-round1.md)
(commit `8975259`). The scripts that measure a model export in the extension are in `validation/candidate-model/`, and
those that build and assemble the dataset in `validation/dataset/`.

One script of the round stays here because sense-model has no counterpart for it yet:

- `mem_probe.py`: peak GPU memory and time of one training step on the longest training prompts, with micro-batches
  of 4, 8 and 16 (with and without gradient checkpointing), and of one teacher batch at the scorer's token budgets. On
  2026-11-25, on an RTX 3060 (12 GB), 4 examples a micro-batch peaked at 6.85 GB and 8 spilled out of the card's
  memory, hence micro-batches of 4 with 16 accumulation steps. It is the record of that run: it imports sense-model from
  `~/src/sense-model/src`, reads the `assets-v1` export at `~/src/sense-model/artifacts/upstream-english`, the teacher
  and the round's prompts under `~/.cache/contextual-dictionary/validation/`, and needs a CUDA GPU. It belongs in
  sense-model, next to `wsd train`.
