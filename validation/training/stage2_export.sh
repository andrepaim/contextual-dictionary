#!/bin/bash
# Stage 2, last step: export the best run (by full-development "labelled meaning first" at 24|c1600, logs/dev-stage2.json)
# with the recipe adjusted to its own outlier layers, check INT8 against float in Python on development prompts, then
# confirm accuracy and latency in the real WASM build on the 24|c1600 test prompts of the three sets.
set -euo pipefail
T=~/.cache/contextual-dictionary/validation/train
cd "$T"
mkdir -p export
PY=../teacher/venv/bin/python
BEST=$(python3 -I -c "
import json
d=json.load(open('logs/dev-stage2.json'))
runs=[k for k in d if k.startswith('s2-')]
print(max(runs, key=lambda k: d[k]['c1600']['first']))")
mkdir -p export
echo "best run on development: $BEST" | tee export/best.txt
[ -s export/act-stats-$BEST.jsonl ] || $PY -I scripts/act_stats_model.py --model checkpoints/$BEST/final --n 200 --out export/act-stats-$BEST.jsonl
[ -s export/$BEST/onnx/model.int8.onnx ] || $PY -I scripts/export_quant.py --model checkpoints/$BEST/final --act-stats export/act-stats-$BEST.jsonl --out export/$BEST
for m in model model.int8; do
  [ "$(wc -l < export/$BEST-$m-dev.jsonl 2>/dev/null || echo 0)" -ge 1000 ] || $PY -I $HOME/src/contextual-dictionary/validation/training/screen.py score --onnx export/$BEST/onnx/$m.onnx --out export/$BEST-$m-dev.jsonl --prompts data/dev-prompts.jsonl --hashes export-test/dev1000.txt --threads 16
done
$PY -I $HOME/src/contextual-dictionary/validation/training/screen.py compare export/$BEST-model-dev.jsonl export/$BEST-model.int8-dev.jsonl > export/$BEST-int8-vs-float-dev.txt
# Browser: nothing else heavy runs at this point of the driver.
bash scripts/run_browser.sh $T/export/$BEST only-24c1600.txt scores-$BEST-recipe.jsonl
cd ~/src/contextual-dictionary-worktrees/train-data
for s in wiktionary written simple; do
  CD_VALIDATION_OUT=$T/browser-out npx tsx validation/analyze.ts --set $s --threads $BEST-recipe > $T/browser-out/analyze-$s-$BEST-recipe.md
done
cd "$T"
python3 -I scripts/latency_train.py $BEST-recipe=scores-$BEST-recipe.jsonl > browser-out/latency-$BEST-recipe.md
