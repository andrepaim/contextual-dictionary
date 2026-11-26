#!/bin/bash
# analyze.ts for every stage 2 model on the three test sets (24|c1600 and 127), and paired bootstrap intervals of
# each trained model minus the untrained float student (compare.py in this folder, 2,000 resamples, seed 1).
set -e
T=~/.cache/contextual-dictionary/validation/train
cd ~/src/contextual-dictionary-worktrees/train-data
for name in untrained s2-labels-only s2-teacher-only s2-labels-teacher; do
  for s in wiktionary written simple; do
    CD_VALIDATION_OUT=$T/test-scores npx tsx validation/analyze.ts --set $s --threads $name > $T/test-scores/analyze-$s-$name.md
  done
done
cd $T
for s in wiktionary written simple; do
  for v in "24|c1600" 127; do
    for m in s2-labels-only s2-teacher-only s2-labels-teacher; do
      python3 -I $HOME/src/contextual-dictionary/validation/training/compare.py --set $s --variant "$v" --teacher $m \
        --scores untrained=$T/test-scores/scores-untrained.jsonl $m=$T/test-scores/scores-$m.jsonl \
        > "$T/test-scores/compare-$s-${v//|/_}-$m.md"
    done
  done
done
