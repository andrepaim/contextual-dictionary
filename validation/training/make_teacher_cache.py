"""Teacher cache in sense-model's format (wsd.teacher / wsd.train.read_teacher) from batched teacher logits.

For each Example (any of the JSONL files), the teacher's logits for its prompt (looked up by provenance.prompt_sha256)
become softmax(logits / T) over the offered meanings and "none of the above", keyed by candidate id, with the
example's fingerprint (wsd.train.example_fingerprint). Examples whose prompt was not scored are skipped (counted).
  venv/bin/python -I make_teacher_cache.py --scores teacher-scores.jsonl --examples A.jsonl[,B.jsonl] --out cache.jsonl [--temperature 2]
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
from wsd.data import read_jsonl  # noqa: E402
from wsd.train import example_fingerprint  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--scores", required=True)
p.add_argument("--examples", required=True)
p.add_argument("--out", required=True)
p.add_argument("--temperature", type=float, default=2.0)
a = p.parse_args()
scores = {}
for line in Path(a.scores).read_text().splitlines():
    if line:
        r = json.loads(line)
        if r["type"] == "scored":
            scores[r["hash"]] = r["logits"]
n = skipped = 0
with open(a.out, "w", encoding="utf-8") as out:
    for f in a.examples.split(","):
        for ex in read_jsonl(f):
            logits = scores.get(ex.provenance.get("prompt_sha256"))
            if logits is None or len(logits) != len(ex.candidates) + 1:
                skipped += 1
                continue
            z = [v / a.temperature for v in logits]
            m = max(z)
            e = [math.exp(v - m) for v in z]
            s = sum(e)
            probs = [v / s for v in e]
            out.write(json.dumps({"id": ex.id, "example_sha256": example_fingerprint(ex),
                                  "probabilities": {c.id: q for c, q in zip(ex.candidates, probs[:-1])}, "none_probability": probs[-1],
                                  "temperature": a.temperature, "teacher_model": "sign/Ettin-1B-WSD",
                                  "teacher_revision": "e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc"}) + "\n")
            n += 1
print(f"cache rows {n}, skipped {skipped}")
