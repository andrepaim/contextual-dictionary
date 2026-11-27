#!/bin/sh
# run_browser.sh MODEL_DIR ONLY_FILE NAME: scores prompts with the model export MODEL_DIR (onnx/model.int8.onnx,
# model_metadata.json, calibration.json, tokenizer.json, tokenizer_config.json) inside the production build of this
# repository (validation/score-prompts.ts: Chromium, the built model worker, onnxruntime-web on WebAssembly), while
# memsample.py samples the renderer's memory. ONLY_FILE lists the prompt hashes to score, one per line (absolute, or
# relative to the run folder). Writes, in the run folder: scores-NAME.jsonl (resumable), mem-scores-NAME.jsonl.json,
# loads.jsonl, and logs/browser-NAME.log.
#
# Run folder: $CD_CANDIDATE_OUT (default ~/.cache/contextual-dictionary/validation/candidate-model), made with
# link_eval.sh from the evaluation folder $CD_VALIDATION_OUT (default ~/.cache/contextual-dictionary/validation).
# Threads: $THREADS (default 8). Needs `npm run build` first. Afterwards, with CD_VALIDATION_OUT set to the run folder,
# `npx tsx validation/analyze.ts --set <set> --threads NAME` reads scores-NAME.jsonl.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
case "$1" in -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
[ $# -eq 3 ] || { echo "usage: run_browser.sh MODEL_DIR ONLY_FILE NAME (--help for more)" >&2; exit 2; }
MODEL=$(cd "$1" && pwd)
RUN=${CD_CANDIDATE_OUT:-$HOME/.cache/contextual-dictionary/validation/candidate-model}
THREADS=${THREADS:-8}
for f in onnx/model.int8.onnx model_metadata.json calibration.json tokenizer.json tokenizer_config.json; do
  [ -f "$MODEL/$f" ] || { echo "not a model export: $MODEL/$f is missing" >&2; exit 1; }
done
sh "$HERE/link_eval.sh" "$RUN"
mkdir -p "$RUN/logs"
RUN=$(cd "$RUN" && pwd)
cd "$HERE/../.."
python3 -I "$HERE/memsample.py" "$RUN/mem-scores-$3.jsonl.json" &
SAMPLER=$!
uptime > "$RUN/logs/browser-$3.log"
CD_MODEL_DIR=$MODEL CD_VALIDATION_OUT=$RUN npx tsx validation/score-prompts.ts --threads "$THREADS" --only "$2" --out "scores-$3.jsonl" >> "$RUN/logs/browser-$3.log" 2>&1 || { kill $SAMPLER; tail -5 "$RUN/logs/browser-$3.log" >&2; exit 1; }
kill $SAMPLER
wait $SAMPLER 2>/dev/null || true
echo "scored into $RUN/scores-$3.jsonl (log $RUN/logs/browser-$3.log, memory $RUN/mem-scores-$3.jsonl.json)"
