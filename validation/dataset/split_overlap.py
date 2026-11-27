"""Training and development passages that are the same or nearly the same, by sense-model's own split check.

Runs sense-model's wsd.data.validate_splits (normalised passage equality, and a five-word-shingle Jaccard of at least
0.8 between passages of 15 words or more) on the training files against the two development forms, keeping every
finding (validate_splits itself returns the first 50), and writes the development item ids involved, one per line, for
validation/entry-order.ts --exclude and the like. Prints counts only, no text.

  python -I validation/dataset/split_overlap.py OUT.txt [--data DIR]

DIR holds the cleaned example files of the round (default $CD_TRAIN_OUT, else
~/.cache/contextual-dictionary/validation/train/data; the dataset's data/ folder has the same files). sense-model is
imported from $SENSE_MODEL_DIR (default ~/src/sense-model); it needs only the standard library.
"""
import argparse
import inspect
import json
import os
import sys
import textwrap
from pathlib import Path

p = argparse.ArgumentParser(usage=__doc__.split("\n\n")[2].strip())
p.add_argument("out", type=Path)
p.add_argument("--data", type=Path, default=Path(os.environ.get("CD_TRAIN_OUT") or Path.home() / ".cache/contextual-dictionary/validation/train/data").expanduser())
a = p.parse_args()
sys.path.insert(0, str(Path(os.environ.get("SENSE_MODEL_DIR") or Path.home() / "src/sense-model").expanduser() / "src"))
import wsd.data  # noqa: E402

# validate_splits' own code, with every finding kept instead of the first 50.
source = textwrap.dedent(inspect.getsource(wsd.data.validate_splits))
if source.count("errors[:50]") != 2:
    raise SystemExit("validate_splits changed: check this script against it")
scope = vars(wsd.data).copy()
exec(source.replace("errors[:50]", "errors"), scope)
D = a.data
report = scope["validate_splits"](
    {"train": [D / "train-labelled.clean.jsonl", D / "train-notoffered.clean.jsonl", D / "unlabelled.clean.jsonl"],
     "dev": [D / "dev-c1600.clean.jsonl", D / "dev-127.clean.jsonl"]},
    strict=False,
)
FORMS = ("|24|c1600", "|127")
item_of = lambda example_id: next(example_id[: -len(f)] for f in FORMS if example_id.endswith(f))
examples, kinds = {"train": set(), "dev": set()}, {"equal": 0, "near duplicates": 0}
for finding in report.get("leakage_examples", []):
    words = finding.split(" ")
    kinds["near duplicates" if words[1] == "near-duplicates" else "equal"] += 1
    for ref in (words[0], words[2]):
        split, example_id = ref.split("/", 1)
        examples[split].add(example_id)
dev_items = sorted({item_of(e) for e in examples["dev"]})
a.out.write_text("".join(i + "\n" for i in dev_items))
print(json.dumps({"findings": kinds, "development examples": len(examples["dev"]), "development items": len(dev_items),
                  "training examples": len(examples["train"]), "training items": len({item_of(e) for e in examples["train"]})}))
