"""Leak checks and data report for training round 1 (no text is printed).

Checks: (1) no train, dev or unlabelled headword (and no looked-up lemma of the unlabelled stream) is held out;
(2) no training or development passage equals a test passage of the English, hand-written or Simple English sets after
normalisation (case folded, non-alphanumerics removed, white space collapsed); also counts passages sharing any
10-word shingle with a test passage; (3) train and dev headwords are disjoint (unlabelled lemmas vs dev too).
It does not compare training passages with development passages (validation/dataset/README.md, "Limits").
  python3 -I validation/dataset/check_leaks.py [--out DIR]

Reads the test sets from $CD_VALIDATION_OUT (default ~/.cache/contextual-dictionary/validation), the builders' items
from $CD_TRAIN_OUT (default $CD_VALIDATION_OUT/train/data) and the held-out lists from validation/data/; writes
leak-report.json and excluded-overlap-ids.txt into --out (default $CD_TRAIN_OUT).
"""
import argparse
import json
import os
import re
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1] / "data"
V = Path(os.environ.get("CD_VALIDATION_OUT") or Path.home() / ".cache/contextual-dictionary/validation").expanduser()
D = Path(os.environ.get("CD_TRAIN_OUT") or V / "train/data").expanduser()
parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument("--out", type=Path, default=D)
OUT = parser.parse_args().out
OUT.mkdir(parents=True, exist_ok=True)


def jsonl(p):
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l]


def lines(name):
    return [l for l in (REPO / name).read_text(encoding="utf-8").splitlines() if l and not l.startswith("#")]


held = {l.split("\t")[0] for l in lines("wiktionary-items.tsv")[1:]} | {l.split("\t")[1] for l in lines("written-labels.tsv")}
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^0-9a-z]+", " ", s.lower())).strip()
passage = lambda sel: (sel.get("before") or "") + sel["text"] + (sel.get("after") or "")


def shingles(s, n=10):
    w = s.split()
    return {" ".join(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}


tests = {s: jsonl(V / f"{s}-items.jsonl") for s in ("wiktionary", "written", "simple")}
test_norm = {s: {norm(passage(it["selection"])) for it in items} for s, items in tests.items()}
test_sh = set().union(*(shingles(norm(passage(it["selection"]))) for items in tests.values() for it in items))
train, dev, unl = jsonl(D / "train-items.jsonl"), jsonl(D / "dev-items.jsonl"), jsonl(D / "unlabelled-items.jsonl")
report = {"held-out headwords": len(held)}
report["(1) train headwords held out"] = sum(it["word"] in held for it in train)
report["(1) dev headwords held out"] = sum(it["word"] in held for it in dev)
report["(1) unlabelled target words or looked-up lemmas held out"] = sum(it["word"] in held or any(l in held for l in it["lemmas"]) for it in unl)
for name, items in (("train", train), ("dev", dev), ("unlabelled", unl)):
    ps = [norm(passage(it["selection"])) for it in items]
    for s in tests:
        report[f"(2) {name} passages equal to a {s} test passage"] = sum(p in test_norm[s] for p in ps)
    report[f"(2) {name} passages sharing a 10-word shingle with any test passage"] = sum(bool(shingles(p) & test_sh) for p in ps)
tw, dw = {it["word"] for it in train}, {it["word"] for it in dev}
report["(3) headwords in both train and dev"] = len(tw & dw)
report["(3) unlabelled lemmas that are dev headwords"] = sum(any(l in dw for l in it["lemmas"]) for it in unl)
report["train headwords"], report["dev headwords"] = len(tw), len(dw)


def table(items):
    t = {}
    t["by meanings in the entry"] = dict(sorted(Counter(it["stratum"] for it in items).items(), key=lambda kv: ["2", "3–4", "5–8", "9–16", "17–32", "33+"].index(kv[0])))
    pos = Counter(it["pos"] for it in items)
    t["by part of speech"] = {k: pos[k] for k in ("noun", "verb", "adj", "adv")} | {"other": sum(v for k, v in pos.items() if k not in ("noun", "verb", "adj", "adv"))}
    t["quotation / usage example"] = dict(Counter(it["exampleType"] for it in items))
    t["labelled meaning offered at 24|c1600"] = sum(bool(it["perCap"].get("24|c1600", {}).get("labelledOffered")) for it in items)
    t["uncapped prompt differs from 24|c1600"] = sum(it["perCap"].get("127", {}).get("prompt") != it["perCap"].get("24|c1600", {}).get("prompt") for it in items)
    t["distinct entries"] = len({(it["word"], it["pos"]) for it in items})
    return t


report["train"], report["dev"] = table(train), table(dev)
print(json.dumps(report, indent=1, ensure_ascii=False))
(OUT / "leak-report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))

# Exclusion list: every train/dev/unlabelled item whose passage equals or shares a 10-word shingle with a test passage.
bad = [it["id"] for items in (train, dev, unl) for it in items if norm(passage(it["selection"])) in set().union(*test_norm.values()) or shingles(norm(passage(it["selection"]))) & test_sh]
(OUT / "excluded-overlap-ids.txt").write_text("\n".join(bad) + "\n")
print(f"excluded for overlap with a test passage: {len(bad)} items")
