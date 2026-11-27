# Measuring a candidate model in the extension

Training, model-level evaluation, the ONNX export and publishing a model happen in
[sense-model](https://github.com/andrepaim/sense-model) (`wsd train`, `wsd score`, `wsd rank`, `wsd export`,
`wsd publish`). What a model does for a reader of the extension is measured here, before a release: accuracy in the
browser at the extension's own prompts, latency, threads and memory, against the model the extension ships. The
numbers of the last time (training round 1, `assets-v2` against `assets-v1`) are in `docs/validation.md`, "In the
extension, against the shipped model (`assets-v1`)". Nothing here runs in CI, and nothing it writes is committed.

## Scripts

| Script | What it does |
| --- | --- |
| `run_browser.sh MODEL_DIR ONLY_FILE NAME` | Scores the listed prompts with a model export inside the production build (`validation/score-prompts.ts`), while `memsample.py` samples the renderer's memory. Writes `scores-NAME.jsonl`, `mem-scores-NAME.jsonl.json`, `loads.jsonl` and `logs/browser-NAME.log` in the run folder. |
| `link_eval.sh DIR` | Makes a run folder: links the evaluation sets' prompts, items and reports into it, so that `score-prompts.ts`, `analyze.ts` and `extension-bench.ts` can use it as `CD_VALIDATION_OUT`. `run_browser.sh` calls it. |
| `memsample.py OUT.json` | The largest Chromium renderer's RSS and PSS every second until stopped (Linux, `/proc`). |
| `compare.py` | Several score files on one test set, item by item, with the rule of `analyze.ts`: tables, and paired bootstrap intervals of one model minus the others (2,000 resamples, seed 1). `--list-prompts` prints a variant's prompt hashes for the sets. |
| `latency.py [--dir DIR] NAME=FILE ...` | Latency tables of `run_browser.sh` runs (percentiles, answers over 750 ms, by prompt length) with their peak memory, and the model load times. |
| `threads_accuracy.py` | Accuracy within the budget by thread count on the 300-item subset of "Fewer threads" (imports `compare.py`). `--list-prompts` prints the subset's prompt hashes. |
| `quiet.sh LABEL LOGFILE` | Waits until the 1-minute load average is below 1.5 and the machine's `java` processes are idle, then logs the load: run it before each timed run. |
| `bench_build.sh OUT_DIR PORT [CHECKOUT]` | A measurement-only copy of the production build that downloads its release from `http://127.0.0.1:PORT/releases`, for `validation/extension-bench.ts` on a release that is not published. |
| `release_server.mjs PORT TAG=DIR ...` | Serves staged release folders on `127.0.0.1` for those builds. |

Every script prints its usage with `--help`. Paths have defaults and can be changed: `CD_VALIDATION_OUT` is the
evaluation folder the sets were built into (default `~/.cache/contextual-dictionary/validation`), `CD_CANDIDATE_OUT`
the run folder (default `~/.cache/contextual-dictionary/validation/candidate-model`), `THREADS` the threads of a
`run_browser.sh` run (default 8). Run the commands below from the repository root.

## Needs

- `npm ci` and `npm run build` (the production `dist/`).
- The evaluation sets, built once as in `docs/validation.md`, "How to rerun" (`build-wiktionary-set.ts`,
  `build-written-set.ts`, `build-simple-set.ts`), and `threads-subset.txt` there.
- Two model exports in the layout of the release's model files (`onnx/model.int8.onnx`, `model_metadata.json`,
  `calibration.json`, `tokenizer.json`, `tokenizer_config.json`):
  - the shipped model: `node scripts/publish-assets.mjs --dry-run` downloads it from its pinned Hugging Face revision
    into `~/.cache/contextual-dictionary/hf-models/andrepaim/Ettin-150m-WSD-wiktionary/<revision>/`
    (`MODEL_SOURCE` in `scripts/assets-release.ts`);
  - the candidate: the output folder of sense-model's `wsd export --quantize`, or a download of its Hugging Face
    revision.
- Python 3 (standard library only) and, for memory, Linux.

## The sequence

```bash
C=~/.cache/contextual-dictionary/validation/candidate-model; mkdir -p $C
SHIPPED=~/.cache/contextual-dictionary/hf-models/andrepaim/Ettin-150m-WSD-wiktionary/0edcbab04bb30eadeeef6babb26e8055b173b8d7
CANDIDATE=<the candidate export>
M=validation/candidate-model
```

**1. Accuracy in the browser, against the shipped model.** The `24|c1600` prompts (the extension's defaults) of the
three test sets, about 6,500 prompts, about 21 minutes per model on 8 threads:

```bash
python3 -I $M/compare.py --list-prompts --set wiktionary,written,simple --variant '24|c1600' > $C/only-24c1600.txt
sh $M/run_browser.sh $SHIPPED only-24c1600.txt shipped
sh $M/run_browser.sh $CANDIDATE only-24c1600.txt candidate
for s in wiktionary written simple; do CD_VALIDATION_OUT=$C npx tsx validation/analyze.ts --set $s --threads candidate > $C/analyze-$s.md; done
for s in wiktionary written simple; do python3 -I $M/compare.py --set $s --teacher candidate --scores shipped=$C/scores-shipped.jsonl candidate=$C/scores-candidate.jsonl > $C/compare-$s.md; done
```

`analyze.ts` gives the tables of `docs/validation.md` for the candidate at the 750 ms budget; `compare.py`, the
candidate against the shipped model item by item, with the paired interval of the difference (no budget). Look at
the items each model gets right that the other gets wrong, and at the site's and the store's examples
(`validation/site-assets.ts`, `validation/store-assets.ts`) with both models.

**2. Latency.** The same prompts with both exports, back to back and then in reverse order, each run after
`quiet.sh`; `latency.py` makes the tables:

```bash
head -600 $C/only-24c1600.txt > $C/latency-600.txt    # or another fixed subset; say how it was chosen
for run in shipped-1:$SHIPPED candidate-1:$CANDIDATE candidate-2:$CANDIDATE shipped-2:$SHIPPED; do
  bash $M/quiet.sh "${run%%:*}" $C/latency-loads.txt
  sh $M/run_browser.sh "${run#*:}" latency-600.txt "latency-${run%%:*}"
done
python3 -I $M/latency.py shipped-1=scores-latency-shipped-1.jsonl candidate-1=scores-latency-candidate-1.jsonl \
  candidate-2=scores-latency-candidate-2.jsonl shipped-2=scores-latency-shipped-2.jsonl
```

**3. Threads.** The 300-item subset with 8, 4 and 2 threads, both models at each count, each run after `quiet.sh`:

```bash
python3 -I $M/threads_accuracy.py --list-prompts > $C/threads-only.txt
for n in 8 4 2; do for model in shipped:$SHIPPED candidate:$CANDIDATE; do
  bash $M/quiet.sh "${model%%:*}-$n" $C/threads-loads.txt
  CD_CANDIDATE_OUT=$C/threads/${model%%:*} THREADS=$n sh $M/run_browser.sh "${model#*:}" $C/threads-only.txt $n
done; done
python3 -I $M/threads_accuracy.py > $C/threads-accuracy.md
```

**4. Memory and the real extension path, on a release that is not published.** On a branch whose
`src/assets/manifest.ts` names the candidate's release (a new tag, and the candidate's stored pins: size and SHA-256
of each model file), stage it, put the transfer pins the dry run prints into the manifest, and build both checkouts
for a local server:

```bash
node scripts/publish-assets.mjs --dry-run --model-dir=$CANDIDATE --out=$C/staged-candidate          # then fill in the transfer pins
node scripts/publish-assets.mjs --dry-run --out=$C/staged-shipped                                   # on main: the shipped release
bash $M/bench_build.sh $C/build-candidate 8765                         # this checkout, with the candidate's pins
bash $M/bench_build.sh $C/build-shipped 8765 <a worktree of main>      # the shipped release's pins
node $M/release_server.mjs 8765 <candidate tag>=$C/staged-candidate assets-v2=$C/staged-shipped &
for b in shipped candidate; do
  sh $M/link_eval.sh $C/bench-$b
  CD_VALIDATION_OUT=$C/bench-$b npx tsx validation/extension-bench.ts --install --build $C/build-$b
  CD_VALIDATION_OUT=$C/bench-$b npx tsx validation/extension-bench.ts --build $C/build-$b --label $b --cap 24 --budget 750 --idle
done
```

`extension-bench.ts` reports the renderer's memory with the dictionary open, with the model loaded, after 400
ordered lookups and after the idle unload, and the model's load time and the lookups' times. Stop the server
afterwards. The staged folders are what `scripts/publish-assets.mjs` would publish: `docs/assets.md`, "Publish a new
release", says how a release is published once the numbers are in `docs/validation.md`.
