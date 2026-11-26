"""Accuracy within the budget for the 300-item thread subset (docs/validation.md, "Fewer threads"): per model and thread
count, the share of ambiguous lookups answered in time and first / top 3 with dictionary order where the answer was late
(compare.py in this folder outcome, the same rule as analyze.ts). Variants 24|c1600 (shipped default) and 48|c1600.
  python3 -I threads_accuracy.py [--runs DIR ...]
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare  # noqa: E402
T = Path.home() / ".cache/contextual-dictionary/validation/train/threads-out"
items = sorted(compare.jsonl(compare.V / "wiktionary-items.jsonl"), key=lambda it: it["id"])
items = [it for i, it in enumerate(items) if i % 5 == 0][:300]
def late(scores, budget):
    return {h: (r if r["type"] != "scored" or r["ms"] <= budget else {**r, "type": "late"}) for h, r in scores.items()}
runs = sys.argv[1:] or ["shipped/scores-8.jsonl", "new/scores-8.jsonl", "shipped/scores-4.jsonl", "new/scores-4.jsonl", "shipped/scores-2.jsonl", "new/scores-2.jsonl"]
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
