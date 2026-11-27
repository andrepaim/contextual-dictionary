"""Latency, load time and memory of browser runs of run_browser.sh: a markdown table per score file (percentiles,
answers over 750 ms, by prompt length) with the peak renderer memory memsample.py recorded beside it
(mem-<file>.json), then the model load times of loads.jsonl.

  python3 -I latency.py [--dir RUN_FOLDER] NAME=FILE [NAME=FILE ...]

FILE is a score file in the run folder (scores-<name>.jsonl), or an absolute path. The run folder defaults to
$CD_CANDIDATE_OUT, else ~/.cache/contextual-dictionary/validation/candidate-model.
"""
import argparse
import json
import os
from pathlib import Path

p = argparse.ArgumentParser(usage=__doc__.split("\n\n")[1].strip())
p.add_argument("--dir", default=os.environ.get("CD_CANDIDATE_OUT") or str(Path.home() / ".cache/contextual-dictionary/validation/candidate-model"))
p.add_argument("runs", nargs="+", metavar="NAME=FILE")
a = p.parse_args()
OUT = Path(a.dir)
BUCKETS = [(0, 128), (129, 256), (257, 384), (385, 512), (513, 10**6)]


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, -(-p * len(xs) // 100) - 1))] if xs else float("nan")


def jl(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l]


print("| Export | Prompts | p50 ms | p90 ms | p99 ms | max ms | over 750 ms | " + " | ".join(f"p50 / max, {a}–{b if b < 10**6 else ''} tokens" for a, b in BUCKETS) + " | peak RSS / PSS MB |")
print("|---|" + "---:|" * (7 + len(BUCKETS)))
for spec in a.runs:
    name, file = spec.split("=", 1)
    rows = [r for r in jl(OUT / file) if r["type"] == "scored"]
    ms = [r["ms"] for r in rows]
    cells = []
    for a, b in BUCKETS:
        g = [r["ms"] for r in rows if a <= r["tokens"] <= b]
        cells.append(f"{pct(g, 50):.0f} / {max(g):.0f} (n={len(g)})" if g else "–")
    mem = (OUT / file).parent / f"mem-{Path(file).name}.json"
    m = json.loads(mem.read_text()) if mem.exists() else {}
    print(f"| {name} | {len(rows)} | {pct(ms, 50):.0f} | {pct(ms, 90):.0f} | {pct(ms, 99):.0f} | {max(ms):.0f} | {sum(x > 750 for x in ms)} | " + " | ".join(cells)
          + f" | {m.get('rss_mb', '–')} / {m.get('pss_mb', '–')} |")
print()
for r in jl(OUT / "loads.jsonl") if (OUT / "loads.jsonl").exists() else []:
    print(f"load: {r['at']} {r['loadMs']:.0f} ms (load avg {r['load'][0]:.2f})")
