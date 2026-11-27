# The dataset export: `andrepaim/wiktionary-wsd`

The training, development and evaluation examples of training round 1, with the teacher's soft labels, are published
as the Hugging Face dataset [`andrepaim/wiktionary-wsd`](https://huggingface.co/datasets/andrepaim/wiktionary-wsd/tree/84b6444e83219aaa76c29a517a64a640c1df9a46)
(revision `84b6444e83219aaa76c29a517a64a640c1df9a46`). The data is built here, because it is built with the
extension's own lookup and prompt code: the builders `validation/build-train-set.ts`, `validation/build-unlabelled-set.ts`
and `validation/training-items.ts`, the evaluation builders, and the scripts of this folder. Training on it is
sense-model's (`docs/wiktionary-round1.md` there). Nothing here runs in CI, and nothing it writes is committed: the
files hold Wiktionary and Wikipedia text.

| Script | What it does |
| --- | --- |
| `wiki_paragraphs.py` | A seeded sample of prose paragraphs from one English Wikipedia parquet shard (the unlabelled stream's input). |
| `prepare_examples.py` | Turns the builders' prompts into sense-model examples, checking that sense-model's `format_prompt` rebuilds each prompt byte for byte. |
| `check_leaks.py` | The leak checks against the test sets: no held-out headword, no passage equal to or sharing a run of ten words with a test passage, training and development headwords disjoint. |
| `split_overlap.py` | sense-model's split check (`validate_splits`) of training against development passages, listing the development items involved (see "Limits"). |
| `entry_lemmas.mts` | Reruns the extension's lookup for every item and records each entry's headword, checked against the stored entry sizes and prompt hashes (for the attribution tables). |
| `assemble.py` | Assembles the dataset folder: copies the training, development and teacher files, converts the test sets, writes the held-out list and the attribution tables, reruns the leak checks on the published files, and writes `manifest.json`. |

`assemble.py` and `entry_lemmas.mts` are the dataset's `scripts/` (at revision `84b6444` byte for byte the versions
committed here before their paths became parameters; `assemble.py` now copies both into the dataset folder itself).

## Inputs and parameters

- The local inputs of `CLAUDE.md`: the Kaikki English extract of 2026-10-30 (`CD_KAIKKI`) and the pack (`CD_PACK`).
- The evaluation sets, built as in `docs/validation.md`, "How to rerun", into the evaluation folder `CD_VALIDATION_OUT`
  (default `~/.cache/contextual-dictionary/validation`, written `$V` below). The working folder of the round is
  `$V/train` (written `$T`); the builders write `$T/data` (`CD_TRAIN_OUT`).
- The Wikipedia shard `20231101.en/train-00001-of-00041.parquet` of
  [`wikimedia/wikipedia`](https://huggingface.co/datasets/wikimedia/wikipedia), revision
  `b04c8d1ceb2f5cd4588862100d08de323dccfbaa`, SHA-256
  `6cd57a5825312ca966313d4a1b614690b5c4fb53cee9b124bc0e999977eb36cf`, at `$T/wiki/train-00001-of-00041.parquet`.
- A sense-model checkout, `SENSE_MODEL_DIR` (default `~/src/sense-model`; `assemble.py --sense-model`), and a Python
  3.12 environment that imports it (its `wsd.tokenizer` needs PyTorch) with `pyarrow`, for example sense-model's
  locked environment or the one of its `docs/wiktionary-round1-requirements.txt`. `check_leaks.py` and
  `split_overlap.py` need only the standard library.
- `prepare_examples.py` reads the answer letters from `model_metadata.json` of `CD_MODEL_DIR` (default
  `~/src/sense-model/artifacts/upstream-english`, as `validation/common.ts`; any export of the shipped contract has
  the same letters, for example the download that `node scripts/publish-assets.mjs --dry-run` makes).
- A CUDA GPU for the teacher's soft labels (step 6), and Node.js with `npm ci` here.

## Rebuild

From the repository root, with `PY` the Python above, `V=${CD_VALIDATION_OUT:-~/.cache/contextual-dictionary/validation}`,
`T=$V/train`, `DATASET` a new folder for the dataset and `WORK` a scratch folder:

```bash
# 1. Labelled training and development items (124,442 and 4,931 with the committed builder; build.json has the counts).
npx tsx validation/build-train-set.ts
# 2-3. The unlabelled stream: paragraphs, then items (47,910).
$PY -I validation/dataset/wiki_paragraphs.py $T/wiki/train-00001-of-00041.parquet $T/data/wiki-paragraphs.jsonl --n 60000
npx tsx validation/build-unlabelled-set.ts --input $T/data/wiki-paragraphs.jsonl
# 4. sense-model examples (seconds each).
E="$PY -I validation/dataset/prepare_examples.py"; D=$T/data
$E --items $D/train-items.jsonl --prompts $D/train-prompts.jsonl --out $D/train-labelled.clean.jsonl --unlabelled-out $D/train-notoffered.clean.jsonl
$E --items $D/dev-items.jsonl --prompts $D/dev-prompts.jsonl --out $D/dev-labelled.clean.jsonl --unlabelled-out $D/dev-notoffered.clean.jsonl
$E --items $D/dev-items.jsonl --prompts $D/dev-prompts.jsonl --out $D/dev-c1600.clean.jsonl --variants '24|c1600'
$E --items $D/dev-items.jsonl --prompts $D/dev-prompts.jsonl --out $D/dev-127.clean.jsonl --variants 127
$E --kind unlabelled --items $D/unlabelled-items.jsonl --prompts $D/unlabelled-prompts.jsonl --out $D/unlabelled.clean.jsonl
# 5. Leak checks: leak-report.json, and excluded-overlap-ids.txt (empty with the committed builder, which already
#    drops what it lists); then training against development (see "Limits").
python3 -I validation/dataset/check_leaks.py
python3 -I validation/dataset/split_overlap.py $WORK/dev-train-overlap-items.txt
# 6. The teacher's soft labels, in sense-model (docs/wiktionary-round1.md there, "Rerun", step 1): raw logits in
#    $T/teacher/teacher-bf16.jsonl, the cache at T = 2 in $T/teacher/cache-stage2-T2.jsonl. The dataset's raw logits also
#    cover the development prompts: score the development files into the same --scores file too.
wsd teacher --model sign/Ettin-1B-WSD --revision e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc --device cuda \
  --dtype bfloat16 --max-tokens 8192 --batch-size 64 --temperature 2 --scores $T/teacher/teacher-bf16.jsonl \
  --input $D/train-labelled.clean.jsonl $D/train-notoffered.clean.jsonl $D/unlabelled.clean.jsonl --output $T/teacher/cache-stage2-T2.jsonl
# 7. The test prompts the models are scored on: both forms of the three test sets.
mkdir -p $T/test-scores && for f in '24|c1600' 127; do python3 -I validation/candidate-model/compare.py --list-prompts --set wiktionary,written,simple --variant "$f"; done | sort -u > $T/test-scores/test-hashes.txt
# 8. The entries' headwords (about 8 minutes), then the dataset (about a minute).
CD_VALIDATION_OUT=$WORK/tmp npx tsx validation/dataset/entry_lemmas.mts $WORK/lemmas-all.jsonl \
  $D/train-items.jsonl $D/dev-items.jsonl $D/unlabelled-items.jsonl $V/wiktionary-items.jsonl $V/written-items.jsonl
$PY -I validation/dataset/assemble.py --out $DATASET --lemmas $WORK/lemmas-all.jsonl
```

## Checks before publishing

- `assemble.py` stops on any failed check: every `ok` line compares a count with the round's (`expect`; a new build
  changes those counts, and `docs/validation.md` with them), and the `check` lines are the leak checks on the files as
  published (also in `reports/assembly-checks.json`), with no local path in any file.
- Compare `$DATASET/manifest.json` with the published one: for an unchanged build, every file under `data/`,
  `teacher/`, `eval/`, `sources/` and `reports/` has the same SHA-256. On 2026-11-27 this folder's scripts, run into a
  new folder from the round's kept files, gave exactly that (and `entry_lemmas.mts` gave the published run's `lemmas-all.jsonl` byte for byte)
  against revision `84b6444`: only `scripts/` and two descriptions in the manifest differ (the paths of this move).
- The dataset card, `README.md` at the dataset's root, is written by hand and not by `assemble.py`: start from the
  published one, and update its numbers, its links (it still names this repository's `validation/training/`, which
  moved to sense-model and here) and its limits.
- Look through the folder for anything that should not be published (`grep -r "$HOME" $DATASET` finds nothing).

## Publish (a separate, explicit step)

Publishing changes a public repository and is done by the owner, by hand, once the checks pass; no script here
uploads anything. With a Hugging Face token that can write to `andrepaim/wiktionary-wsd`:

```bash
hf upload andrepaim/wiktionary-wsd $DATASET . --repo-type dataset --commit-message "<what changed>"
```

`hf` prints the new commit. Pin that full revision wherever the dataset is named (`docs/validation.md`, this file,
`NOTICE.md`, and sense-model's `docs/wiktionary-round1.md` and configurations); never refer to `main`.

## Limits

- **Training and development passages are not compared with each other.** `build-train-set.ts` splits by headword
  (`sha256("cd-train-r1\n" + headword)`) and checks training and development passages against the test sets only
  (`check_leaks.py`), so the same quotation filed under two headwords can land on both sides. sense-model's split check
  (`split_overlap.py`) finds, between the training files and the two development forms of revision `84b6444`, 90 equal
  and 668 near-duplicate passages, involving 232 of the 4,931 development items (451 development examples of the two
  prompt forms) and 341 training examples (317 items). Development numbers, and the choices made on them, may be
  somewhat optimistic; the test sets are not affected. **The next build should fix this**, for example by dropping
  from development every item whose passage equals or nearly duplicates a training passage, by `split_overlap.py`'s
  rule, before anything is chosen on it. The builders are unchanged so far, so that they still rebuild revision
  `84b6444`.
- The rest of the round's limits are in `docs/validation.md`, "Training round 1 (assets-v2)", and the dataset card.
