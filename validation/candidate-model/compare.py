"""Teacher versus student tables and paired bootstrap intervals.

Reimplements validation/analyze.ts `outcome` (contextualOrder on the stored logits; a skipped,
missing or rejected prompt or a "none of the above" answer leaves dictionary order) so that several
score files can be compared item by item. Its single-file numbers are checked against analyze.ts.

  python3 -I compare.py --set wiktionary --variant '24|c1600' --scores int8=scores-8.jsonl pt=scores-student-pt.jsonl teacher=scores-teacher.jsonl
"""

import argparse
import json
import math
import random
from pathlib import Path

V = Path.home() / ".cache/contextual-dictionary/validation"
NOTA = 127
STRATA = [(2, 2), (3, 4), (5, 8), (9, 16), (17, 32), (33, math.inf)]


def jsonl(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l]


IGNORE_NOTA = False  # --ignore-nota: rank by the offered meanings even when "none of the above" wins (diagnostic only)


def outcome(item, variant, scores):
    dictionary = item["labelled"]["sense"] + 1
    info = item["perCap"][variant]
    if "skip" in info:
        return dictionary, "skipped"
    score = scores.get(info["prompt"])
    if score is None:
        return dictionary, "missing"
    if score["type"] != "scored" or not score.get("logits"):
        return dictionary, f"rejected:{score.get('code')}"
    values = score["logits"]
    m = max(values)
    exp = [math.exp(v - m) for v in values]
    total = sum(exp)
    probs = [e / total for e in exp]
    none = probs.pop()
    if none >= max(probs) and not IGNORE_NOTA:
        return dictionary, "none"
    entry, sense = item["labelled"]["entry"], item["labelled"]["sense"]
    p = {(e, s): probs[i] for i, (e, s) in enumerate(info["candidates"])}
    count = item["entrySenses"][entry]
    scored = sorted([s for s in range(count) if (entry, s) in p], key=lambda s: (-p[(entry, s)], s))
    rest = [s for s in range(count) if (entry, s) not in p]
    return (scored + rest).index(sense) + 1, "applied"


def summary(ranks):
    n = len(ranks)
    return sum(r == 1 for r in ranks) / n, sum(r <= 3 for r in ranks) / n, sum(ranks) / n


def bootstrap(a, b, seed, resamples=2000):
    rng = random.Random(seed)
    n = len(a)
    diffs = []
    for _ in range(resamples):
        total = 0
        for _ in range(n):
            j = rng.randrange(n)
            total += a[j] - b[j]
        diffs.append(total / n)
    diffs.sort()
    return diffs[int(0.025 * resamples)], diffs[int(0.975 * resamples) - 1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--set", required=True)
    p.add_argument("--variant", default="24|c1600")
    p.add_argument("--scores", nargs="+", required=True, help="name=file pairs; the first is the baseline of the intervals")
    p.add_argument("--teacher", default="teacher")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--ignore-nota", action="store_true")
    a = p.parse_args()
    global IGNORE_NOTA
    IGNORE_NOTA = a.ignore_nota
    items = jsonl(V / f"{a.set}-items.jsonl")
    named = {}
    for spec in a.scores:
        name, file = spec.split("=", 1)
        named[name] = {r["hash"]: r for r in jsonl(V / file)}
    pct = lambda x: f"{100 * x:.1f}%"
    outs = {name: [outcome(it, a.variant, s) for it in items] for name, s in named.items()}
    print(f"## {a.set}, {a.variant}: {len(items)} items")
    for name, o in outs.items():
        kinds = {}
        for _, k in o:
            kinds[k] = kinds.get(k, 0) + 1
        print(f"- {name}: outcomes {kinds}")
    print()
    print("| Order | First | Top 3 | Mean rank |")
    print("| --- | ---: | ---: | ---: |")
    t1, t3, mr = summary([it["labelled"]["sense"] + 1 for it in items])
    print(f"| dictionary | {pct(t1)} | {pct(t3)} | {mr:.2f} |")
    for name, o in outs.items():
        t1, t3, mr = summary([r for r, _ in o])
        print(f"| {name} | {pct(t1)} | {pct(t3)} | {mr:.2f} |")
    print()
    if a.set == "wiktionary":
        names = list(outs)
        print("| Meanings in entry | Items | First, dictionary | " + " | ".join(f"First, {n}" for n in names) + " | Top 3, dictionary | "
              + " | ".join(f"Top 3, {n}" for n in names) + " | Mean rank, dictionary | " + " | ".join(f"Mean rank, {n}" for n in names) + " |")
        print("| --- | ---: |" + " ---: |" * (3 * (len(names) + 1)))
        for low, high in STRATA + [(0, math.inf)]:
            idx = [i for i, it in enumerate(items) if low <= it["meanings"] <= high] if low else list(range(len(items)))
            label = "All" if not low else (f"{low}+" if high == math.inf else str(low) if low == high else f"{low}–{high}")
            d = summary([items[i]["labelled"]["sense"] + 1 for i in idx])
            m = [summary([outs[n][i][0] for i in idx]) for n in names]
            print(f"| {label} | {len(idx)} | {pct(d[0])} | " + " | ".join(pct(x[0]) for x in m) + f" | {pct(d[1])} | "
                  + " | ".join(pct(x[1]) for x in m) + f" | {d[2]:.2f} | " + " | ".join(f"{x[2]:.2f}" for x in m) + " |")
        print()
    if a.teacher in outs:
        teacher = [1 if r == 1 else 0 for r, _ in outs[a.teacher]]
        for name, o in outs.items():
            if name == a.teacher:
                continue
            other = [1 if r == 1 else 0 for r, _ in o]
            low, high = bootstrap(teacher, other, a.seed)
            print(f"Labelled meaning first, {a.teacher} minus {name}: {pct(sum(teacher) / len(items) - sum(other) / len(items))} "
                  f"(paired bootstrap 95% interval {pct(low)} to {pct(high)}, 2,000 resamples, seed {a.seed})")
        ambiguous = [k for _, k in outs[a.teacher] if k != "skipped"]
        print(f"\n{a.teacher}: none of the above on {sum(k == 'none' for k in ambiguous)} of {len(ambiguous)} prompted items "
              f"({pct(sum(k == 'none' for k in ambiguous) / len(ambiguous))}); rejected too long {sum(k == 'rejected:TOO_LONG' for k in ambiguous)}; "
              f"missing {sum(k == 'missing' for k in ambiguous)}")
        for name, o in outs.items():
            if name != a.teacher:
                amb = [k for _, k in o if k != "skipped"]
                print(f"{name}: none of the above {sum(k == 'none' for k in amb)}, rejected {sum(k.startswith('rejected') for k in amb)}, missing {sum(k == 'missing' for k in amb)}")


if __name__ == "__main__":
    main()
