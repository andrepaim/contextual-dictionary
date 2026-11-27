"""Accuracy within the budget for the 300-item thread subset (docs/validation.md, "Fewer threads"): per model and thread
count, the share of ambiguous lookups answered in time and first / top 3 with dictionary order where the answer was late
(compare.py in this folder outcome, the same rule as analyze.ts). Variants 24|c1600 (shipped default) and 48|c1600.

  python3 -I threads_accuracy.py --list-prompts > threads-only.txt
  python3 -I threads_accuracy.py [--dir THREADS_FOLDER] [RUN ...]

The subset is every fifth Wiktionary item in id order, the first 300 (as analyze-threads.ts), read from
$CD_VALIDATION_OUT (default ~/.cache/contextual-dictionary/validation). --list-prompts prints the prompt hashes of the
subset for the variants 48, 48|c1200, 48|c1600 and 24|c1600 (the ONLY_FILE of the thread runs). Each RUN is a score
file relative to the threads folder ($CD_CANDIDATE_OUT/threads, default
~/.cache/contextual-dictionary/validation/candidate-model/threads); the default runs are shipped/ and candidate/
scores-8, -4 and -2.jsonl.
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare  # noqa: E402

RUN = os.environ.get("CD_CANDIDATE_OUT") or str(Path.home() / ".cache/contextual-dictionary/validation/candidate-model")
p = argparse.ArgumentParser(usage=__doc__.split("\n\n")[1].strip())
p.add_argument("--dir", default=str(Path(RUN) / "threads"))
p.add_argument("--list-prompts", action="store_true")
p.add_argument("runs", nargs="*", metavar="RUN")
a = p.parse_args()
T = Path(a.dir)
items = sorted(compare.jsonl(compare.V / "wiktionary-items.jsonl"), key=lambda it: it["id"])
items = [it for i, it in enumerate(items) if i % 5 == 0][:300]
if a.list_prompts:
    print("\n".join(sorted({it["perCap"][v]["prompt"] for it in items for v in ("48", "48|c1200", "48|c1600", "24|c1600") if "prompt" in it["perCap"].get(v, {})})))
    sys.exit(0)


def late(scores, budget):
    return {h: (r if r["type"] != "scored" or r["ms"] <= budget else {**r, "type": "late"}) for h, r in scores.items()}


runs = a.runs or [f"{model}/scores-{n}.jsonl" for n in (8, 4, 2) for model in ("shipped", "candidate")]
print("| Run | Variant | Answered in time, 500 / 750 / 1000 ms | First at 750 ms | Top 3 at 750 ms | First, no budget |")
print("|---|---|---|--:|--:|--:|")
for run in runs:
    scores = {json.loads(l)["hash"]: json.loads(l) for l in open(T / run)}
    for variant in ("24|c1600", "48|c1600"):
        amb = [it for it in items if "prompt" in it["perCap"][variant]]
        shares = []
        for b in (500, 750, 1000):
            s = sum(1 for it in amb if scores[it["perCap"][variant]["prompt"]]["type"] == "scored" and scores[it["perCap"][variant]["prompt"]]["ms"] <= b) / len(amb)
            shares.append(f"{100 * s:.0f}%")
        r750 = [compare.outcome(it, variant, late(scores, 750))[0] for it in items]
        r_inf = [compare.outcome(it, variant, scores)[0] for it in items]
        t1, t3, _ = compare.summary(r750)
        print(f"| {run} | {variant} | {' / '.join(shares)} | {100 * t1:.1f}% | {100 * t3:.1f}% | {100 * compare.summary(r_inf)[0]:.1f}% |")
