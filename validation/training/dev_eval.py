"""Development accuracy from score files (no text printed).

  python3 -I dev_eval.py NAME=SCORES.jsonl [...] [--items data/dev-items.jsonl] [--json OUT]

For each form (24|c1600, 127): over all development items, as analyze.ts computes it (compare.py in this folder
outcome: contextualOrder on the logits; skipped, missing, rejected or "none of the above" leaves dictionary order):
first, top three, mean rank; and the in-training metric over items whose labelled meaning is offered:
argmax over offered + none-of-the-above is the labelled meaning ("offered_first") and labelled in the top three offered.
Also by meanings in the entry (first, all items) for 24|c1600 and 127.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare  # noqa: E402  (outcome, summary, STRATA)

D = Path.home() / ".cache/contextual-dictionary/validation/train"


def jl(p):
    return [json.loads(l) for l in Path(p).read_text().splitlines() if l]


def evaluate(items, scores):
    res = {}
    for form in ("24|c1600", "127"):
        ranks = [compare.outcome(it, form, scores)[0] for it in items]
        t1, t3, mr = compare.summary(ranks)
        off1 = off3 = n = 0
        for it in items:
            info = it["perCap"].get(form, {})
            if not info.get("labelledOffered"):
                continue
            s = scores.get(info["prompt"])
            if not s or s["type"] != "scored":
                continue
            gold = [tuple(c) for c in info["candidates"]].index((it["labelled"]["entry"], it["labelled"]["sense"]))
            lg = s["logits"]
            n += 1
            off1 += max(range(len(lg)), key=lambda i: lg[i]) == gold
            off3 += gold in sorted(range(len(lg) - 1), key=lambda i: -lg[i])[:3]
        key = "c1600" if form == "24|c1600" else "uncapped"
        res[key] = {"first": t1, "top3": t3, "mean_rank": mr, "offered_first": off1 / max(n, 1), "offered_top3": off3 / max(n, 1), "offered_n": n,
                    "by_meanings_first": {}}
        for low, high in compare.STRATA:
            idx = [i for i, it in enumerate(items) if low <= it["meanings"] <= high]
            if idx:
                label = f"{low}+" if high == float("inf") else str(low) if low == high else f"{low}-{high}"
                res[key]["by_meanings_first"][label] = (sum(ranks[i] == 1 for i in idx) / len(idx), len(idx))
    res["dictionary"] = compare.summary([it["labelled"]["sense"] + 1 for it in items])
    return res


def main():
    p = argparse.ArgumentParser()
    p.add_argument("scores", nargs="+")
    p.add_argument("--items", default=str(D / "data/dev-items.jsonl"))
    p.add_argument("--exclude", default=str(D / "data/excluded-overlap-ids.txt"))
    p.add_argument("--json")
    a = p.parse_args()
    bad = set(Path(a.exclude).read_text().split()) if a.exclude else set()
    items = [it for it in jl(a.items) if it["id"] not in bad]
    out = {"items": len(items)}
    for spec in a.scores:
        name, f = spec.split("=", 1)
        out[name] = evaluate(items, {r["hash"]: r for r in jl(f)})
    d = out[next(iter(out.keys() - {"items"}))]["dictionary"]
    print(f"dev items {len(items)}; dictionary order first {100 * d[0]:.1f}% top3 {100 * d[1]:.1f}% mean rank {d[2]:.2f}")
    for name in [k for k in out if k != "items"]:
        for form in ("c1600", "uncapped"):
            r = out[name][form]
            print(f"{name:24s} {form:8s} first {100 * r['first']:.1f}%  top3 {100 * r['top3']:.1f}%  mean rank {r['mean_rank']:.2f}  | offered-only first {100 * r['offered_first']:.1f}% top3 {100 * r['offered_top3']:.1f}% (n={r['offered_n']})  by meanings: "
                  + ", ".join(f"{k} {100 * v[0]:.1f}" for k, v in r["by_meanings_first"].items()))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
