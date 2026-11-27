"""Turn extension-built prompts into sense-model Examples (wsd.schema) for the trainer, with exact-form checks.

For every item and variant (24|c1600, 127) with a prompt, an Example is made from the prompt itself: the passage
(first line without the two target asterisks), the target span (code points, from the extension's request) and
the offered definitions in the extension's order. wsd.tokenizer.format_prompt(example) must reproduce the
extension's prompt string exactly, or the example is dropped and counted.
Labels: gold_ids = [the labelled meaning] when it is offered. When the cap leaves it out, the prompt is NOT made a
"none of the above" example; it is kept only as an unlabelled (teacher-only) example in the --unlabelled-out file.
Identical prompts of one item (both variants the same) appear once.
  python -I validation/dataset/prepare_examples.py --items train-items.jsonl --prompts train-prompts.jsonl --out train-labelled.jsonl [--unlabelled-out FILE] [--kind labelled|unlabelled]

Imports sense-model's wsd package from the checkout at $SENSE_MODEL_DIR (default ~/src/sense-model), and reads the
answer letters from model_metadata.json of the model export at $CD_MODEL_DIR (default
~/src/sense-model/artifacts/upstream-english, as validation/common.ts; any export of the compact-v1 contract has the
same letters).
"""
import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

SENSE_MODEL = Path(os.environ.get("SENSE_MODEL_DIR") or Path.home() / "src/sense-model").expanduser()
sys.path.insert(0, str(SENSE_MODEL / "src"))
from wsd.schema import Candidate, Example, Target  # noqa: E402
from wsd.tokenizer import format_prompt  # noqa: E402

MODEL_DIR = Path(os.environ.get("CD_MODEL_DIR") or Path.home() / "src/sense-model/artifacts/upstream-english").expanduser()
META = json.loads((MODEL_DIR / "model_metadata.json").read_text())


class Tok:  # format_prompt needs only mask_token
    mask_token = "[MASK]"


def example_from_prompt(pid, prompt, target, cand_ids, gold, provenance):
    lines = prompt.split("\n")
    marked, choices = lines[0], lines[1:-2]
    points = list(marked)
    s, e = target["start"], target["end"]
    assert points[s] == "*" and points[e + 1] == "*", "markers"
    passage = "".join(points[:s] + points[s + 1 : e + 1] + points[e + 2 :])
    defs = []
    for i, line in enumerate(choices):
        prefix = f"{META['letters'][i]}. "
        assert line.startswith(prefix), "choice prefix"
        defs.append(line[len(prefix):])
    assert len(defs) == len(cand_ids), "candidate count"
    ex = Example(id=pid, text=passage, target=Target(s, e, target["text"]), candidates=[Candidate(c, d) for c, d in zip(cand_ids, defs)],
                 gold_ids=gold, provenance=provenance)
    ex.validate()
    assert format_prompt(ex, Tok, META) == prompt, "prompt differs"
    return ex


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--items", required=True)
    p.add_argument("--prompts", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--unlabelled-out")
    p.add_argument("--kind", default="labelled", choices=["labelled", "unlabelled"])
    p.add_argument("--variants", default="24|c1600,127")
    a = p.parse_args()
    prompts = {json.loads(l)["hash"]: json.loads(l) for l in Path(a.prompts).read_text(encoding="utf-8").splitlines() if l}
    counts = Counter()
    out = open(a.out, "w", encoding="utf-8")
    unl = open(a.unlabelled_out, "w", encoding="utf-8") if a.unlabelled_out else None
    for line in Path(a.items).read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        item = json.loads(line)
        seen = set()
        for variant in a.variants.split(","):
            info = item["perCap"].get(variant, {})
            if "prompt" not in info or info["prompt"] in seen:
                counts[f"{variant}: skipped or duplicate of the other variant"] += 1
                continue
            seen.add(info["prompt"])
            pr = prompts[info["prompt"]]
            cand_ids = [f"{e}:{s}" for e, s in info["candidates"]]
            prov = {"source": "English Wiktionary (kaikki.org extract 2026-10-30)" if a.kind == "labelled" else "English Wikipedia 20231101 (wikimedia/wikipedia)",
                    "license": "CC BY-SA 4.0" if a.kind == "labelled" else "CC BY-SA 3.0", "document_id": item["id"],
                    "annotation": "human" if a.kind == "labelled" else "unlabeled", "variant": variant, "prompt_sha256": pr["hash"],
                    "split_group": item.get("word")}
            if a.kind == "labelled":
                gold_id = f"{item['labelled']['entry']}:{item['labelled']['sense']}"
                gold = [gold_id] if info["labelledOffered"] else None
            else:
                gold = None
            try:
                ex = example_from_prompt(f"{item['id']}|{variant}", pr["prompt"], pr["target"], cand_ids, gold, prov)
            except (AssertionError, ValueError) as err:
                counts[f"dropped: {err}"] += 1
                continue
            if a.kind == "labelled" and gold is None:
                counts[f"{variant}: labelled meaning not offered (teacher-only)"] += 1
                if unl:
                    unl.write(json.dumps(ex.to_dict(), ensure_ascii=False) + "\n")
                continue
            (out if a.kind == "labelled" else out).write(json.dumps(ex.to_dict(), ensure_ascii=False) + "\n")
            counts[f"{variant}: written"] += 1
    out.close()
    if unl:
        unl.close()
    print(json.dumps(counts, indent=1))


if __name__ == "__main__":
    main()
