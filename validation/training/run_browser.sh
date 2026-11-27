#!/bin/sh
# run_browser.sh MODEL_DIR ONLY_FILE OUT_FILE: validation/score-prompts.ts (production build in the train-data worktree,
# onnxruntime-web 1.30 WASM, 8 threads) with MODEL_DIR (model_metadata.json, calibration.json, tokenizer files,
# onnx/model.int8.onnx); writes train/browser-out/OUT_FILE and loads.jsonl there; samples renderer memory.
set -e
T=~/.cache/contextual-dictionary/validation/train
cd ~/src/contextual-dictionary-worktrees/train-data
python3 -I ~/.cache/contextual-dictionary/validation/quant/scripts/memsample.py $T/browser-out/mem-$3.json &
SAMPLER=$!
uptime > $T/logs/browser-$3.log
CD_MODEL_DIR=$1 CD_VALIDATION_OUT=$T/browser-out npx tsx validation/score-prompts.ts --threads 8 --prompts $T/browser-out/prompts.jsonl --only $2 --out $3 >> $T/logs/browser-$3.log 2>&1 || { kill $SAMPLER; exit 1; }
kill $SAMPLER
