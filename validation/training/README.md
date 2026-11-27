# Training round 1: scripts as run

The Python and shell scripts that made the model of `assets-v2` from the data the two TypeScript builders write
(`validation/build-train-set.ts`, `validation/build-unlabelled-set.ts`). Method and numbers are in `docs/validation.md`,
"Training round 1"; this file says how the round ran, step by step, so that it can be run again. Nothing here runs in CI.

Everything the round wrote is under `~/.cache/contextual-dictionary/validation/` and stays on the maintainer's machine:
the training data, prompts, teacher caches and examples hold Wiktionary and Wikipedia text, and the checkpoints alone
are 16 GB. The float weights of the model are public on Hugging Face (see "Where the weights and the working files are").

## Scripts

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
| `run_browser.sh`, `memsample.py`, `latency_train.py` | A run of `validation/score-prompts.ts` in the built extension with a given model export, while `memsample.py` samples the renderer's memory; `latency_train.py` makes the latency tables of those runs. |
| `quiet.sh`, `threads_accuracy.py`, `bench_build.sh`, `release_server.mjs`, `mem_probe.py` | Measurement helpers: wait for a quiet machine, accuracy within the budget by threads, a measurement-only build that downloads from a loopback server (for `validation/extension-bench.ts` on an unpublished release), GPU memory of the longest batches. |
| `requirements.txt` | The Python environment the scripts ran in, frozen. |

## Environment

- **Python.** `requirements.txt` is the frozen environment (Python 3.12.3; PyTorch 2.14.1 with CUDA 13.0 from PyTorch's
  own index, transformers 5.23.0, onnx 1.23.2, onnxruntime 1.32.0, tokenizers 0.23.3, pyarrow 26.0.1, tensorboard
  2.21.0); its header gives the install command. On the machine used it is the virtual environment
  `~/.cache/contextual-dictionary/validation/teacher/venv`, which the scripts call as `../teacher/venv/bin/python`
  (written `$PY` below). `dev_eval.py`, `compare.py`, `check_leaks.py`, `threads_accuracy.py`, `latency_train.py` and
  `memsample.py` need only the standard library and ran with the system `python3`.
- **GPU.** NVIDIA GeForce RTX 3060 (12 GB), driver 610.88. Training, teacher scoring, the activation statistics and the
  ONNX export use CUDA; `screen.py` scores ONNX graphs on the CPU.
- **Node.js** and a checkout of this repository with `npm ci` and `npm run build`, for the builders, `analyze.ts` and
  `score-prompts.ts` (`docs/validation.md`, "Machine and load").
- **sense-model.** The scripts import the trainer library from a checkout at `~/src/sense-model` and never change it.
  The path is hard-coded: `sys.path` gets `~/src/sense-model/src` in `prepare_examples.py`, `make_teacher_cache.py`,
  `score_batch.py`, `train_thin.py`, `act_stats_model.py`, `export_quant.py` and `mem_probe.py`; the student that is
  fine-tuned, the `assets-v1` export, is read from `~/src/sense-model/artifacts/upstream-english` (`train_thin.py`,
  `stage2.sh`, `prepare_examples.py`, `screen.py`, `mem_probe.py`, and `release_model_dir.py --shipped`), and the
  export's parity fixtures from `~/src/sense-model/data/fixtures/smoke.jsonl` (`export_quant.py`). That checkout is at
  commit `2e6c41de21b5c3ca4ba9658507836722108fb963` ("Record final manifest generator regression checks",
  2026-11-15) on `main`, with a clean working tree. That this is the code the round imported on 2026-11-25 and 26 rests
  on what the machine showed on 2026-11-27: the reflog has no entry after 2026-11-15, and no file outside the ignored
  `artifacts/` folder has changed since then. `artifacts/upstream-english` is ignored by sense-model's git, so it has
  no commit; the SHA-256 of its weights is `f2a39baf5b70bb78ddca49f826d8bb7dacd25b76420e4f58bc102ec1bfb0c0bf`.
- **Teacher.** `sign/Ettin-1B-WSD` at the revision given in `docs/validation.md`, in
  `~/.cache/contextual-dictionary/validation/teacher/model/Ettin-1B-WSD` (`stage2.sh` reads it as
  `../teacher/model/Ettin-1B-WSD`). How it was downloaded was not recorded.
- **Other fixed paths.** `train_thin.py` writes TensorBoard events to
  `~/.cache/contextual-dictionary/validation/train/runs/`; `dev_eval.py`, `compare.py`, `check_leaks.py`,
  `threads_accuracy.py`, `mem_probe.py`, `act_stats_model.py` and `screen.py` read fixed paths under
  `~/.cache/contextual-dictionary/validation/`.

## The working folder

The scripts ran from `~/.cache/contextual-dictionary/validation/train/` (written `T` below), not from the repository:
they were copied there by hand, into `T/scripts/`, and `stage2.sh` and the others call `scripts/<name>` relative to `T`.
A rerun needs the same layout, for example:

```bash
T=~/.cache/contextual-dictionary/validation/train
mkdir -p $T/scripts $T/data $T/wiki $T/teacher $T/logs
cp validation/training/*.py validation/training/*.sh validation/training/*.mjs $T/scripts/
```

What the folder holds after the round:

| Folder | Contents |
| --- | --- |
| `scripts/` | The copies that ran (see below). |
| `data/` | The builders' items and prompts, the sense-model examples (`*.jsonl`, `*.clean.jsonl`), `build.json`, `leak-report.json`, `excluded-overlap-ids.txt`, `wiki-paragraphs.jsonl`, `pilot-train.jsonl`. |
| `wiki/` | The Wikipedia shard. |
| `teacher/` | Teacher scores (`teacher-bf16.jsonl`), the teacher caches, the hash lists they were scored from, and the fp32 development scores of every model. |
| `checkpoints/<run>/` | `args.json`, `baseline.json` (development scores before training), `metrics.jsonl` (every logged step), `metrics.json`, the last two checkpoints in `checkpoints/`, and the final model in `final/` (the best checkpoint). |
| `runs/<run>/` | TensorBoard events. |
| `logs/` | One log per step, `stage2.log` (the driver's history), the development summaries. |
| `done/`, `stage2.status`, `stage2.pid` | The driver's state: an empty file per finished step, its current status line, its process. |
| `test-scores/`, `export/`, `browser-out/` | Test scoring and analysis; exports, activation statistics and INT8 checks; runs in the built extension. |
| `threads-out/`, `bench/` | The thread-count and memory measurements against `assets-v1`. |
| `export-test/`, `archive/` | The pilot's export test; the pilot's first attempt and two short trainer checks. |
| `rebuild-check/` | The committed `build-train-set.ts` run again on 2026-11-26 (step 1). |

The scripts also read from the folders beside `T`, under `~/.cache/contextual-dictionary/validation/`: the stage 3
evaluation files (`prompts.jsonl`, `wiktionary-items.jsonl`, `written-items.jsonl`, `simple-items.jsonl`,
`wiktionary-build.json`, `scores-8.jsonl`, `threads-subset.txt`, written by the evaluation builders and
`score-prompts.ts`); `teacher/` (the environment, the teacher model, and `teacher/scripts/` of the teacher study of
2026-11-25: `compare.py`, `agree.py`); and `quant/` (the quantization study of 2026-11-25: `quant/scripts/screen.py`,
`quant/scripts/memsample.py`, `quant/out/only-24c1600.txt`, and `quant/browser/int8-pc-ex-wo5-embfp16`, the untrained
model exported with the same recipe). `test-scores/` and `browser-out/` hold symbolic links to the evaluation files, so
that `analyze.ts` finds them under `CD_VALIDATION_OUT`.

The repository steps ran in two worktrees that no longer exist: `~/src/contextual-dictionary-worktrees/train-data`
(the builders, and `analyze.ts` and `score-prompts.ts` for `test_analysis.sh`, `stage2_export.sh` and the browser runs)
and `~/src/contextual-dictionary-worktrees/model-r1` (the build with the new pins, for the thread and memory
measurements). Any checkout of this repository with a production build does the same work, but the committed scripts
name these paths: `test_analysis.sh` and `stage2_export.sh` `cd` to the `train-data` worktree and call `compare.py` and
`screen.py` in a checkout at `~/src/contextual-dictionary`; the last part of `stage2_export.sh` calls
`scripts/run_browser.sh` and `scripts/latency_train.py`, and `run_browser.sh` also `cd`s to the `train-data` worktree and
runs `memsample.py` from `~/.cache/contextual-dictionary/validation/quant/scripts/`. As committed, then,
`test_analysis.sh`, `run_browser.sh` and the last part of `stage2_export.sh` run only where a checkout sits at the
`train-data` path; steps 13 and 15 give what they ran.

### The committed scripts against the copies that ran

Compared byte for byte with `T/scripts/` on 2026-11-27:

- **Identical:** `act_stats_model.py`, `bench_build.sh`, `export_quant.py`, `make_teacher_cache.py`, `mem_probe.py`,
  `prepare_examples.py`, `quiet.sh`, `release_server.mjs`, `score_batch.py`, `stage2.sh`, `train_thin.py`,
  `wiki_paragraphs.py`, and `run_browser.sh` and `latency_train.py` (committed on 2026-11-27). `compare.py`,
  `screen.py` and `memsample.py` are identical to the copies that ran from `../teacher/scripts/` and
  `../quant/scripts/`.
- **Paths only:** `check_leaks.py` reads `validation/data/` next to itself (the copy read
  `~/src/contextual-dictionary/validation/data`); `dev_eval.py` and `threads_accuracy.py` import `compare.py` from
  their own folder (the copies, from `../teacher/scripts/`); `stage2_export.sh` and `test_analysis.sh` call `screen.py`
  and `compare.py` at `~/src/contextual-dictionary/validation/training/` (the copies, at `../quant/scripts/` and
  `../teacher/scripts/`). Their comments changed to match.
- **Not in `T/scripts/`:** `release_model_dir.py` ran from the repository (step 16 checks its output again).
- **The builders:** `T/scripts/build-train-set.ts` and `build-unlabelled-set.ts` are copies of the versions that ran on
  2026-11-25. The committed `build-train-set.ts` also drops a passage equal to or overlapping a test passage and a
  repeated identifier (steps 6 and 7 did that after the fact on 2026-11-25), and writes under `CD_TRAIN_OUT` instead of
  `CD_VALIDATION_OUT`; run again on 2026-11-26, it wrote exactly the 124,442 training and 4,931 development items the
  runs used. The committed `build-unlabelled-set.ts` takes its exclusions from `validation/training-items.ts`
  (`blockedLookup` also tests the word itself, which the line before already does) and writes under `CD_TRAIN_OUT`; it
  was not run again.

The one-off scripts in `T/scripts/` that are not committed, and what each did (the steps below give their commands):
`pilot.sh` (the pilot run); `train_thin.pilot.py` (a copy of the trainer from the afternoon of 2026-11-25, before the
resume support and the epoch-seeded sampler); `teacher_check.sh` (batched against one-at-a-time teacher scores, and
throughput); `export_labels_teacher.sh` (the export steps of `stage2_export.sh` for the run that ships);
`browser_labels_teacher.sh` (the browser runs of the run that ships); `threads_runs.sh` and `threads_repeat4.sh`
(the thread-count runs); `bench_runs.sh` (the `extension-bench.ts` runs).

## Steps

Times are those of the machine above, from the logs where they record them; clock times are UTC. Commands run from the
repository root (`npx`, `node`, `python3 -I validation/...`) or from `T` (`$PY`, `scripts/...`), as each shows, with
`PY=../teacher/venv/bin/python`.

**0. Inputs.** The local inputs of `CLAUDE.md` (the Kaikki English extract of 2026-10-30, the pack, the model export),
and the stage 3 evaluation sets: `build-wiktionary-set.ts`, `build-written-set.ts` and `build-simple-set.ts` ("How to
rerun" in `docs/validation.md`), which write `wiktionary-items.jsonl`, `written-items.jsonl`, `simple-items.jsonl` and
`prompts.jsonl` under `~/.cache/contextual-dictionary/validation/`. The training builders read the test passages from
there and the held-out headwords from `validation/data/`.

**1. Labelled items** (repository):

```bash
npx tsx validation/build-train-set.ts        # --seed cd-train-r1 --dev-share 0.04 --per-entry 12 are the defaults
```

Writes `T/data/train-items.jsonl`, `dev-items.jsonl`, `train-prompts.jsonl`, `dev-prompts.jsonl` and `build.json`. The
version that ran on 2026-11-25 wrote 125,031 training and 4,951 development items, with 131,315 and 5,221 distinct
prompts; the committed one writes 124,442 and 4,931, with 130,664 and 5,200 (`T/rebuild-check/build.json`): the items
that steps 6 and 7 leave.

**2. The Wikipedia shard.** `20231101.en/train-00001-of-00041.parquet` of `wikimedia/wikipedia`, at the revision and
SHA-256 given in `docs/validation.md`, saved as `T/wiki/train-00001-of-00041.parquet`. How it was downloaded was not
recorded.

**3. Paragraphs** (from `T`):

```bash
$PY -I scripts/wiki_paragraphs.py wiki/train-00001-of-00041.parquet data/wiki-paragraphs.jsonl --n 60000
```

**4. Unlabelled items** (repository):

```bash
npx tsx validation/build-unlabelled-set.ts --input ~/.cache/contextual-dictionary/validation/train/data/wiki-paragraphs.jsonl
```

Writes `T/data/unlabelled-items.jsonl` (47,910 items), `unlabelled-prompts.jsonl` (55,052 prompts) and
`unlabelled-build.json`.

**5. Examples** (from `T`, seconds each). Run again on 2026-11-27 into another folder, these commands gave files byte
for byte equal to the ones in `T/data/`:

```bash
$PY -I scripts/prepare_examples.py --items data/train-items.jsonl --prompts data/train-prompts.jsonl --out data/train-labelled.jsonl --unlabelled-out data/train-notoffered.jsonl
$PY -I scripts/prepare_examples.py --items data/dev-items.jsonl --prompts data/dev-prompts.jsonl --out data/dev-labelled.jsonl --unlabelled-out data/dev-notoffered.jsonl
$PY -I scripts/prepare_examples.py --items data/dev-items.jsonl --prompts data/dev-prompts.jsonl --out data/dev-c1600.jsonl --variants '24|c1600'
$PY -I scripts/prepare_examples.py --items data/dev-items.jsonl --prompts data/dev-prompts.jsonl --out data/dev-127.jsonl --variants 127
$PY -I scripts/prepare_examples.py --kind unlabelled --items data/unlabelled-items.jsonl --prompts data/unlabelled-prompts.jsonl --out data/unlabelled.jsonl
```

`train-labelled.jsonl` holds the labelled examples of both forms (the no-cap form only where its prompt differs),
`train-notoffered.jsonl` the prompts whose labelled meaning the cap leaves out (used with the teacher's answers only),
and `dev-c1600.jsonl` and `dev-127.jsonl` the development examples of each form for the trainer's evaluations.

**6. Leak checks** (from `T`):

```bash
python3 -I scripts/check_leaks.py
```

Writes `data/leak-report.json` (counts only) and `data/excluded-overlap-ids.txt`: on 2026-11-25, 605 item identifiers
(585 training, 20 development) whose passage equals or shares a run of ten words with a test passage. The committed
builder leaves exactly those items out already, so with it the list comes out empty.

**7. Cleaned examples** (2026-11-25 only). Each `*.clean.jsonl` is its file of step 5 without the examples whose
`provenance.document_id` is in `excluded-overlap-ids.txt`, and with an example identifier that appears twice kept once
(the first): 129,093 labelled training examples (of 129,740), 1,658 teacher-only (of 1,667), 4,846 and 4,907
development examples of the two forms, and `unlabelled.clean.jsonl` equal to `unlabelled.jsonl`. The one-off command
was not kept. With the committed builder, step 5's commands with the `.clean.jsonl` names as `--out` and
`--unlabelled-out` give these files directly (checked byte for byte on 2026-11-27 from `T/rebuild-check/`).

**8. Hash lists** (one-off commands, not kept; each list checked on 2026-11-27 against what it holds):

- `teacher/stage2-hashes.txt`: the distinct prompts (`provenance.prompt_sha256`) of `train-labelled.clean.jsonl`,
  `train-notoffered.clean.jsonl` and `unlabelled.clean.jsonl`, 185,716.
- `teacher/pilot-hashes.txt`: the distinct prompts of `pilot-train.jsonl` and `dev-labelled.clean.jsonl`, 45,126.
- `test-scores/test-hashes.txt`: the `24|c1600` and `127` prompts of the three evaluation sets, 7,420.
- `browser-out/only-24c1600.txt` (a link to `quant/out/only-24c1600.txt`): their `24|c1600` prompts, 6,548.
- `export-test/dev1000.txt`: the first 1,000 development prompt hashes in sorted order.

**9. Reference scores on development** (2026-11-25). The untrained student and the teacher scored all 5,221
development prompts in fp32 with `score_batch.py` (`--label student` and `--label teacher`), into
`teacher/student-dev-fp32.jsonl` and `teacher/teacher-dev-fp32.jsonl`; those command lines were not kept. Then:

```bash
python3 -I scripts/dev_eval.py student=teacher/student-dev-fp32.jsonl teacher-fp32=teacher/teacher-dev-fp32.jsonl --json logs/dev-reference.json
```

(the kept `logs/dev-reference.json` also has a `teacher-bf16` entry, from the bf16 scores as they stood then).
`dev_eval.py` leaves out the 20 development items of `excluded-overlap-ids.txt`, so it counts 4,931 items.
`logs/reference-scalars.json`, the flat reference lines of the TensorBoard charts, holds the `student` and
`teacher-fp32` entries of `dev-reference.json` (first and top three among the prompts whose labelled meaning is offered,
and first over all items), copied by a one-off command.

**10. Teacher checks** (`teacher_check.sh`, 2026-11-25, about 5 minutes; `logs/teacher-check.log`). 1,500 evaluation
prompts (`teacher/check-hashes.txt`) scored in batches and compared with the one-at-a-time teacher scores of the teacher
study (`../scores-teacher.jsonl`, by `../teacher/scripts/agree.py`): fp32 batches agree on every top choice, with no
logit difference at four decimals; 13.2 and 12.3 prompts a second at token budgets of 8,192 and 16,384; bf16 38.2
prompts a second, agreeing on 99.4% of top choices.

**11. The pilot** (2026-11-25). Teacher soft labels for `pilot-hashes.txt` in bf16, written to
`teacher/teacher-bf16.jsonl`, the file the driver later extends (34,688 prompts in 7.2 minutes, then the GPU ran out of
memory, and the resumed scorer did the other 10,438 in 7.1 minutes: `logs/teacher-pilot.log`, `teacher-pilot2.log`);
then `make_teacher_cache.py` into `teacher/cache-pilot-T2.jsonl` (39,999 rows). `data/pilot-train.jsonl` holds 39,999
examples of `train-labelled.clean.jsonl`; the command that drew them was not kept. The run (`pilot.sh`):

```bash
$PY -I scripts/train_thin.py --run-name pilot-labels-teacher --output checkpoints/pilot-labels-teacher \
  --train data/pilot-train.jsonl --dev data/dev-c1600.clean.jsonl --dev127 data/dev-127.clean.jsonl --dev-limit 2000 \
  --teacher-scores teacher/cache-pilot-T2.jsonl --epochs 1 --batch-size 8 --grad-accum 8 --save-steps 100 --reference logs/reference-scalars.json
```

One epoch is 625 steps of 64 examples, about 2 seconds a step. The first attempt
(`archive/pilot-labels-teacher-first-attempt/`, `logs/pilot-labels-teacher.log`, `pilot-resume1.log`) stopped at step
394 (its log ends there). Resumed from checkpoint 300, its training loss over the same steps differed from the first
pass (0.772 against 0.834 at step 310, 0.611 against 0.695 at step 320): the length-grouped sampler had drawn a new
batch order. The resume then failed at the step-400 save (`KeyError: 'C1600EarlyStopping'`: checkpoint 300 had been
written with the stock early-stopping callback). The second attempt, with the epoch-seeded sampler of `train_thin.py`,
ran from 20:38 to 21:01 (`checkpoints/pilot-labels-teacher/`, `logs/pilot-run2.log`, `pilot-run2-resume.log`); it was
interrupted after step 330 and resumed from checkpoint 300 onto the same batches (0.8531 against 0.8534 at step 310,
0.7639 against 0.7643 at step 320). The score of the trainer's evaluations (labelled meaning first on 2,000
development prompts whose labelled meaning is offered) went from 69.5% to 74.8%, best at step 500.

Around the pilot, all on 2026-11-25:

- `$PY -I scripts/mem_probe.py` (`logs/mem-probe.log`): on the longest batch (1,858 tokens), 4 examples a micro-batch
  peak at 6.85 GB allocated and take 1.02 s a step; 8 reserve 12.68 GB and take 6.44 s, spilling out of the card's
  memory. Hence micro-batches of 4 with 16 accumulation steps in stage 2.
- A 60-step run with those settings took 90 s (`archive/pilot-timing-micro4/`, `logs/timing-micro4.log`), and a
  3-step teacher-only run tried `--drop-labels` (`archive/smoke-teacher-only/`, `logs/smoke-teacher-only.log`).
- The pilot model went through the export of step 14 into `export-test/pilot/` and was scored in the built extension
  on 100 development prompts (`browser-out/dev100.txt`, `logs/browser-smoke-pilot.log`), to try the export path.

**12. Stage 2, the driver** (from `T`; 2026-11-25 21:08 to 2026-11-26 12:49, including a stop of 8 h 48 min that the
owner asked for):

```bash
cd ~/.cache/contextual-dictionary/validation/train && setsid nohup scripts/stage2.sh > logs/stage2.nohup 2>&1 < /dev/null &
```

It needs, from the steps above: the `.clean.jsonl` files; `teacher/stage2-hashes.txt`; `teacher/teacher-bf16.jsonl`
(the pilot's scores are reused: the scorer skips prompts already in its output); `teacher/student-dev-fp32.jsonl` and
`teacher/teacher-dev-fp32.jsonl`; `logs/reference-scalars.json`; `test-scores/test-hashes.txt` with the links of
`test-scores/`; `export-test/dev1000.txt` and the links of `browser-out/`. Each step leaves `done/<step>` and is skipped
on a rerun; a training step resumes from its newest complete checkpoint; a file `T/STOP` makes the driver stop before
its next step (that is how the owner's stop was made). Its environment variables `EPOCHS`, `MICRO`, `ACCUM`,
`CKPT_FLAGS` and `SAVE_STEPS` default to the values used (3, 4, 16, none, 300). With `COMMON` = `--dev
data/dev-c1600.clean.jsonl --dev127 data/dev-127.clean.jsonl --dev-limit 2000 --epochs 3 --batch-size 4 --grad-accum 16
--save-steps 300 --patience 4 --reference logs/reference-scalars.json` and `TRAIN_ALL` =
`data/train-labelled.clean.jsonl,data/train-notoffered.clean.jsonl,data/unlabelled.clean.jsonl`, its steps
(`logs/stage2.log`):

| Step | Command (from `stage2.sh`) | Took |
| --- | --- | ---: |
| `teacher-scores` | `$PY -I scripts/score_batch.py --model ../teacher/model/Ettin-1B-WSD --prompts data/train-prompts.jsonl,data/unlabelled-prompts.jsonl,data/dev-prompts.jsonl --hashes teacher/stage2-hashes.txt --out teacher/teacher-bf16.jsonl --dtype bfloat16 --max-tokens 8192 --label teacher-bf16` | 58 min (145,729 prompts; the other 39,987 were the pilot's) |
| `teacher-cache` | `$PY -I scripts/make_teacher_cache.py --scores teacher/teacher-bf16.jsonl --examples $TRAIN_ALL --out teacher/cache-stage2-T2.jsonl` | 15 s (185,889 rows) |
| `s2-labels-only` | `$PY -I scripts/train_thin.py --run-name s2-labels-only --output checkpoints/s2-labels-only --train data/train-labelled.clean.jsonl $COMMON` | 1 h 36 min |
| `s2-teacher-only` | `$PY -I scripts/train_thin.py --run-name s2-teacher-only --output checkpoints/s2-teacher-only --train $TRAIN_ALL --drop-labels --teacher-scores teacher/cache-stage2-T2.jsonl $COMMON` | 50 min, stopped, then 1 h 2 min from checkpoint 1,800 |
| `s2-labels-teacher` | `$PY -I scripts/train_thin.py --run-name s2-labels-teacher --output checkpoints/s2-labels-teacher --train $TRAIN_ALL --teacher-scores teacher/cache-stage2-T2.jsonl $COMMON` | 1 h 48 min |
| `dev-<run>` | `$PY -I scripts/score_batch.py --model checkpoints/<run>/final --prompts data/dev-prompts.jsonl --out teacher/<run>-dev-fp32.jsonl --dtype float32 --max-tokens 8192 --label <run>` | about 1 min each |
| `dev-summary` | `python3 -I scripts/dev_eval.py untrained=teacher/student-dev-fp32.jsonl teacher=teacher/teacher-dev-fp32.jsonl s2-labels-only=teacher/s2-labels-only-dev-fp32.jsonl s2-teacher-only=teacher/s2-teacher-only-dev-fp32.jsonl s2-labels-teacher=teacher/s2-labels-teacher-dev-fp32.jsonl --json logs/dev-stage2.json > logs/dev-stage2.txt` | seconds |
| `test-<model>` | `$PY -I scripts/score_batch.py --model <dir> --prompts ../prompts.jsonl --hashes test-scores/test-hashes.txt --out test-scores/scores-<model>.jsonl --dtype float32 --max-tokens 8192 --label <model>`, for the untrained student and the three final models | about 2 min each |
| `test-analysis` | `bash scripts/test_analysis.sh` (step 13) | 1 min |
| `export` | `bash scripts/stage2_export.sh` (step 14) | 26 min |

A training step's log is `logs/s2-<run>.log`. The runs spent 2 to 5 minutes encoding before the first step, and
`s2-labels-teacher` trained at 0.68 steps a second, development evaluations included. `dev_eval.py`, run again on
2026-11-27 with the arguments of `dev-summary`, wrote `logs/dev-stage2.json` and `dev-stage2.txt` byte for byte again.

**13. Test analysis** (`test_analysis.sh`). In a checkout of the repository, for each model and set,
`CD_VALIDATION_OUT=$T/test-scores npx tsx validation/analyze.ts --set <set> --threads <model>` (`analyze.ts` reads
`scores-<model>.jsonl` there); then for each set, form and trained model, `compare.py --set <set> --variant <form>
--teacher <model> --scores untrained=test-scores/scores-untrained.jsonl <model>=test-scores/scores-<model>.jsonl`
(absolute paths in the script), the paired intervals against the untrained student. Outputs: `test-scores/analyze-*.md` and `compare-*.md`.

**14. Export.** `stage2_export.sh` exported the best run on development (`s2-labels-only`, `export/best.txt`) and ran
it in the extension (step 15); after the owner chose `s2-labels-teacher`, `export_labels_teacher.sh` ran the same
export steps for it (2026-11-26 15:23 to 15:28, `logs/export-labels-teacher.log`). From `T`, with `R` the run:

```bash
$PY -I scripts/act_stats_model.py --model checkpoints/$R/final --n 200 --out export/act-stats-$R.jsonl
$PY -I scripts/export_quant.py --model checkpoints/$R/final --act-stats export/act-stats-$R.jsonl --out export/$R
$PY -I ../quant/scripts/screen.py score --onnx export/$R/onnx/model.onnx --out export/$R-model-dev.jsonl --prompts data/dev-prompts.jsonl --hashes export-test/dev1000.txt --threads 16
$PY -I ../quant/scripts/screen.py score --onnx export/$R/onnx/model.int8.onnx --out export/$R-model.int8-dev.jsonl --prompts data/dev-prompts.jsonl --hashes export-test/dev1000.txt --threads 16
$PY -I ../quant/scripts/screen.py compare export/$R-model-dev.jsonl export/$R-model.int8-dev.jsonl > export/$R-int8-vs-float-dev.txt
```

`export/$R/` gets the float export (`onnx/model.onnx`, `parity.json` and the model files), `onnx/model.int8.onnx` and
`recipe.json`. The two `screen.py` scorings took 2.0 and 1.4 minutes. The committed `stage2_export.sh` calls the
repository's `screen.py` instead, which is the same file.

**15. In the extension.** `bash scripts/run_browser.sh EXPORT ONLY OUT` runs, in the `train-data` checkout with a
production build:

```bash
CD_MODEL_DIR=<export> CD_VALIDATION_OUT=$T/browser-out npx tsx validation/score-prompts.ts --threads 8 --prompts $T/browser-out/prompts.jsonl --only <hash list> --out <scores file>
```

while `python3 -I ~/.cache/contextual-dictionary/validation/quant/scripts/memsample.py
$T/browser-out/mem-<scores file>.json` samples the renderer's memory, and writes its log to `logs/browser-<scores
file>.log`. Then `analyze.ts --set <set> --threads <name>` with `CD_VALIDATION_OUT=$T/browser-out`, and `python3 -I
scripts/latency_train.py <name>=<scores file> ...` for the latency tables (it reads `browser-out/`). For the run that ships, `browser_labels_teacher.sh` (2026-11-26 15:30 to 16:28) scored the 6,548
`24|c1600` test prompts (21 minutes), then the 600 prompts of `browser-out/latency-subset-600.txt` with three exports
(the untrained model with the same recipe, labels only, labels and teacher) twice, in reverse order the second time
(about 3 minutes a run), each run started once the 1-minute load average was below 1.5 (`browser-out/latency-loads.txt`).
The command that chose the 600 prompts was not kept. The comparisons with `assets-v1` then ran from the `model-r1`
worktree. Threads: `threads_runs.sh` and `threads_repeat4.sh` (16:38 to 17:58), `score-prompts.ts --threads 8, 4 or 2
--only only-threads.txt` with each model and `CD_VALIDATION_OUT=$T/threads-out/<model>`, each run after `quiet.sh`,
summarised by `threads_accuracy.py`. Memory: `bench_build.sh <checkout> <out> 8765` for each build, `node
scripts/release_server.mjs 8765 assets-v1=<staged assets-v1> assets-v2=<staged assets-v2>`, and `bench_runs.sh`
(`extension-bench.ts --install --build <out>` once per build, then `--build <out> --label r1 or r2 --cap 24 --budget
750`, `--idle` on the second runs; 18:04 to 18:42).

**16. The release folder** (repository). The model export that `publish-assets.mjs` stages, then the dry run:

```bash
python3 -I validation/training/release_model_dir.py --export ~/.cache/contextual-dictionary/validation/train/export/s2-labels-teacher --weights ~/.cache/contextual-dictionary/validation/train/checkpoints/s2-labels-teacher/final/model.safetensors --shipped ~/src/sense-model/artifacts/upstream-english --out ~/.cache/contextual-dictionary/release-staging/assets-v2-model
node scripts/publish-assets.mjs --dry-run --model-dir=$HOME/.cache/contextual-dictionary/release-staging/assets-v2-model --out=<staging folder>
```

`release_model_dir.py`, run again on 2026-11-27 into a new folder, gave files byte for byte equal to those of
`release-staging/assets-v2-model/`. The dry run verifies the inputs, stages the release and prints its pins; the staged
folder `release-staging/assets-v2-final/` holds the files of the release. Publishing is in `docs/assets.md`.

## Where the weights and the working files are

- **The float weights.** The trained checkpoint is `T/checkpoints/s2-labels-teacher/final/model.safetensors`
  (598,827,368 bytes, SHA-256 `49bc2634bcf696171f367b59cedb961fcd71bb7d825ad6680ef5ed1ed8d25be3`; the step-3,000
  checkpoint). `MODEL_REVISION` in `src/model/session.ts` is `sha256:` followed by this hash. The GitHub release
  `assets-v2` holds only the INT8 graph. The Hugging Face repository [`andrepaim/Ettin-150m-WSD-wiktionary`](https://huggingface.co/andrepaim/Ettin-150m-WSD-wiktionary/tree/affc67b9a87c51a07ce642726cee993c593ad744)
  (public, revision `affc67b9`) holds these weights (`model.safetensors`, the same SHA-256), the float ONNX export
  (`onnx/model.onnx`, equal to `export/s2-labels-teacher/onnx/model.onnx`), the INT8 graph (`onnx/model.int8.onnx`, equal to the release's graph once unpacked),
  `onnx/recipe.json`, `config.json`, `calibration.json`, `model_metadata.json`, the tokenizer files, `LICENSE`, `NOTICE`
  and a model card. Its `tokenizer.json` is the checkpoint's copy (3,583,387 bytes), not the release's (3,583,228).
- **Everything else stays on the maintainer's machine.** The items, prompts, examples, teacher caches and paragraphs
  hold Wiktionary or Wikipedia text, which is never committed. The score files hold only prompt hashes, logits and
  times, and mean nothing without the prompt files. The working folder is about 32 GB, 16 GB of it checkpoints (with
  their optimiser states). The training curves (`metrics.jsonl` and the TensorBoard events under `runs/`) hold numbers
  only and are small; they stay with the rest of the round's working files, and `docs/validation.md` quotes the numbers
  it uses from them.
