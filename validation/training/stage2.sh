#!/bin/bash
# Stage 2 driver (training round 1). Start detached, as its own process group:
#   cd ~/.cache/contextual-dictionary/validation/train && setsid nohup scripts/stage2.sh > logs/stage2.nohup 2>&1 < /dev/null &
# Files (fixed names, for the GPU watchdog and the coordinator):
#   stage2.pid     the driver's PID (it leads its process group: a signal to -PID reaches the running step)
#   stage2.status  one line: time, current step, running / done / stopped: <reason> / failed: <reason>
#   STOP           if present: start no step, retry nothing, write "stopped: <contents>" and exit. A SIGTERM while STOP
#                  exists is a requested stop, not a crash.
# Each step runs at most 3 times; a finished step leaves done/<step> and is skipped on a rerun. Training steps resume from
# their newest complete checkpoint (train_thin.py), teacher scoring skips prompts already scored (score_batch.py).
set -u
T=~/.cache/contextual-dictionary/validation/train
cd "$T" || exit 1
PY=../teacher/venv/bin/python
TEACHER=../teacher/model/Ettin-1B-WSD
STUDENT=$HOME/src/sense-model/artifacts/upstream-english
WORKTREE=$HOME/src/contextual-dictionary-worktrees/train-data
EPOCHS=${EPOCHS:-3}
MICRO=${MICRO:-4}          # micro-batch; MICRO * ACCUM = 64. 4 x 1,858 tokens (the longest stage 2 batch) peaks at
ACCUM=${ACCUM:-16}         # 6.85 GB allocated (logs/mem-probe.log); 8 x 1,858 needs 12.7 GB reserved and spills.
CKPT_FLAGS=${CKPT_FLAGS:-}  # e.g. --gradient-checkpointing
SAVE_STEPS=${SAVE_STEPS:-300}
mkdir -p done logs test-scores
echo $$ > stage2.pid
STEP=start
CHILD=

stamp() { date -u +%FT%TZ; }
status() { echo "$(stamp) step=$STEP $1" > stage2.status.tmp && mv stage2.status.tmp stage2.status; echo "$(stamp) step=$STEP $1" >> logs/stage2.log; }
stop_if_requested() {
  if [ -f STOP ]; then
    status "stopped: $(head -c 300 STOP | tr '\n' ' ')"
    exit 0
  fi
}
on_term() {
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  if [ -f STOP ]; then status "stopped: $(head -c 300 STOP | tr '\n' ' ')"; exit 0; fi
  status "failed: SIGTERM received without STOP"
  exit 1
}
trap on_term TERM INT

run_step() {
  local name=$1; shift
  STEP=$name
  if [ -f "done/$name" ]; then echo "$(stamp) skip $name (done)" >> logs/stage2.log; return 0; fi
  local attempt rc
  for attempt in 1 2 3; do
    stop_if_requested
    status "running (attempt $attempt)"
    "$@" >> "logs/s2-$name.log" 2>&1 &
    CHILD=$!
    wait "$CHILD"; rc=$?
    CHILD=
    if [ "$rc" -eq 0 ]; then touch "done/$name"; status "finished"; return 0; fi
    stop_if_requested
    status "running: attempt $attempt exited with code $rc"
    sleep 60
  done
  status "failed: $name exited non-zero 3 times (see logs/s2-$name.log)"
  exit 1
}

TRAIN_ALL=data/train-labelled.clean.jsonl,data/train-notoffered.clean.jsonl,data/unlabelled.clean.jsonl
COMMON="--dev data/dev-c1600.clean.jsonl --dev127 data/dev-127.clean.jsonl --dev-limit 2000 --epochs $EPOCHS --batch-size $MICRO --grad-accum $ACCUM --save-steps $SAVE_STEPS --patience 4 --reference logs/reference-scalars.json $CKPT_FLAGS"

run_step teacher-scores $PY -I scripts/score_batch.py --model $TEACHER --prompts data/train-prompts.jsonl,data/unlabelled-prompts.jsonl,data/dev-prompts.jsonl \
  --hashes teacher/stage2-hashes.txt --out teacher/teacher-bf16.jsonl --dtype bfloat16 --max-tokens 8192 --label teacher-bf16
run_step teacher-cache $PY -I scripts/make_teacher_cache.py --scores teacher/teacher-bf16.jsonl --examples $TRAIN_ALL --out teacher/cache-stage2-T2.jsonl
run_step s2-labels-only $PY -I scripts/train_thin.py --run-name s2-labels-only --output checkpoints/s2-labels-only --train data/train-labelled.clean.jsonl $COMMON
run_step s2-teacher-only $PY -I scripts/train_thin.py --run-name s2-teacher-only --output checkpoints/s2-teacher-only --train $TRAIN_ALL --drop-labels --teacher-scores teacher/cache-stage2-T2.jsonl $COMMON
run_step s2-labels-teacher $PY -I scripts/train_thin.py --run-name s2-labels-teacher --output checkpoints/s2-labels-teacher --train $TRAIN_ALL --teacher-scores teacher/cache-stage2-T2.jsonl $COMMON
# Development scoring of each final model (all development items, fp32): the basis for choosing the model to export.
for run in s2-labels-only s2-teacher-only s2-labels-teacher; do
  run_step dev-$run $PY -I scripts/score_batch.py --model checkpoints/$run/final --prompts data/dev-prompts.jsonl --out teacher/$run-dev-fp32.jsonl --dtype float32 --max-tokens 8192 --label $run
done
run_step dev-summary bash -c "python3 -I scripts/dev_eval.py untrained=teacher/student-dev-fp32.jsonl teacher=teacher/teacher-dev-fp32.jsonl s2-labels-only=teacher/s2-labels-only-dev-fp32.jsonl s2-teacher-only=teacher/s2-teacher-only-dev-fp32.jsonl s2-labels-teacher=teacher/s2-labels-teacher-dev-fp32.jsonl --json logs/dev-stage2.json > logs/dev-stage2.txt"
# Test sets, once per finished experiment: 24|c1600 and 127 prompts of the three sets, fp32, then analyze.ts and the paired intervals.
for m in untrained:$STUDENT s2-labels-only:checkpoints/s2-labels-only/final s2-teacher-only:checkpoints/s2-teacher-only/final s2-labels-teacher:checkpoints/s2-labels-teacher/final; do
  name=${m%%:*}; dir=${m#*:}
  run_step test-$name $PY -I scripts/score_batch.py --model $dir --prompts ../prompts.jsonl --hashes test-scores/test-hashes.txt --out test-scores/scores-$name.jsonl --dtype float32 --max-tokens 8192 --label $name
done
run_step test-analysis bash scripts/test_analysis.sh
# Best run on development: activation outliers, ONNX export with the quantization recipe, browser confirmation.
run_step export bash scripts/stage2_export.sh
STEP=all
status "done"
