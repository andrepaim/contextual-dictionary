#!/bin/sh
# link_eval.sh DIR: makes DIR a folder that validation/score-prompts.ts, analyze.ts and extension-bench.ts can use as
# CD_VALIDATION_OUT for a candidate model: links the evaluation files (the prompts, the three sets' items and the
# builders' reports) from the evaluation folder ($CD_VALIDATION_OUT, default ~/.cache/contextual-dictionary/validation),
# so that the candidate's scores and logs stay apart from the shipped model's. Existing files are left alone.
set -e
case "$1" in ''|-h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; [ -n "$1" ]; exit $? ;; esac
EVAL=${CD_VALIDATION_OUT:-$HOME/.cache/contextual-dictionary/validation}
DIR=$1
mkdir -p "$DIR"
for f in prompts.jsonl wiktionary-items.jsonl written-items.jsonl simple-items.jsonl wiktionary-build.json simple-build.json threads-subset.txt; do
  [ -e "$EVAL/$f" ] || { echo "missing $EVAL/$f (build the evaluation sets first: docs/validation.md, \"How to rerun\")" >&2; exit 1; }
  [ -e "$DIR/$f" ] || ln -s "$(cd "$EVAL" && pwd)/$f" "$DIR/$f"
done
