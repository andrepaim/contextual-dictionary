"""Score development prompts with an ONNX candidate in Python ONNX Runtime (CPU) and compare with the float reference.

  venv/bin/python -I screen.py score --onnx FILE --out FILE [--prompts dev/dev-prompts.jsonl] [--hashes dev/screen-hashes.txt] [--threads 16] [--opt all|disabled]
  venv/bin/python -I screen.py compare REF.jsonl CAND.jsonl [...]

Score lines: hash, type, logits (offered meanings in candidate order, then "none of the above"), ms, tokens, offered.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

Q = Path.home() / ".cache/contextual-dictionary/validation/quant"
TOKENIZER = Path.home() / "src/sense-model/artifacts/upstream-english/tokenizer.json"


def jsonl(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l]


def score(a):
    import onnxruntime as ort
    from tokenizers import Tokenizer

    prompts = {r["hash"]: r for r in jsonl(a.prompts)}
    hashes = [h for h in Path(a.hashes).read_text().split() if h]
    out = Path(a.out)
    done = {r["hash"] for r in jsonl(out)} if out.exists() else set()
    todo = [h for h in hashes if h not in done]
    tok = Tokenizer.from_file(str(TOKENIZER))
    mask = tok.token_to_id("[MASK]")
    options = ort.SessionOptions()
    options.intra_op_num_threads = a.threads
    options.graph_optimization_level = {"all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL, "disabled": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
                                        "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC}[a.opt]
    t0 = time.time()
    session = ort.InferenceSession(a.onnx, options, providers=["CPUExecutionProvider"])
    print(f"loaded in {time.time() - t0:.1f} s; {len(todo)} to score", file=sys.stderr, flush=True)
    start = time.time()
    with out.open("a") as stream:
        for h in todo:
            row = prompts[h]
            ids = tok.encode(row["prompt"]).ids
            t = time.perf_counter()
            logits = session.run(["logits"], {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
                "prediction_positions": np.array([ids.index(mask)], dtype=np.int64),
            })[0].reshape(-1)[:128].astype(np.float64).tolist()
            stream.write(json.dumps(dict(hash=h, type="scored", logits=logits[: row["offered"]] + [logits[127]],
                                         ms=round((time.perf_counter() - t) * 1000, 1), tokens=len(ids), offered=row["offered"])) + "\n")
    print(f"scored {len(todo)} in {(time.time() - start) / 60:.1f} min", file=sys.stderr, flush=True)


def metrics(ref, cand):
    common = [h for h in ref if h in cand and ref[h]["type"] == "scored" and cand[h]["type"] == "scored"]
    top = top3 = 0
    errs, maxerr, gaps = [], [], []
    for h in common:
        r, c = np.array(ref[h]["logits"]), np.array(cand[h]["logits"])
        top += int(r.argmax() == c.argmax())
        k = min(3, len(r) - 1)
        top3 += int(set(np.argsort(-r[:-1])[:k]) == set(np.argsort(-c[:-1])[:k]))
        # compare after removing the per-prompt mean: order depends only on differences
        d = (c - c.mean()) - (r - r.mean())
        errs.append(np.sqrt(np.mean(d ** 2)))
        maxerr.append(np.abs(d).max())
    n = len(common)
    return dict(n=n, top1_agree=top / n, top3_set_agree=top3 / n, rmse_median=float(np.median(errs)), rmse_mean=float(np.mean(errs)),
                maxerr_p90=float(np.percentile(maxerr, 90)))


def compare(a):
    ref = {r["hash"]: r for r in jsonl(a.files[0])}
    for f in a.files[1:]:
        m = metrics(ref, {r["hash"]: r for r in jsonl(f)})
        print(f"{Path(f).stem:40s} n={m['n']:5d} top1 {100 * m['top1_agree']:5.1f}%  top3-set {100 * m['top3_set_agree']:5.1f}%  "
              f"centred RMSE median {m['rmse_median']:.3f} mean {m['rmse_mean']:.3f}  max-err p90 {m['maxerr_p90']:.3f}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score")
    s.add_argument("--onnx", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--prompts", default=str(Q / "dev/dev-prompts.jsonl"))
    s.add_argument("--hashes", default=str(Q / "dev/screen-hashes.txt"))
    s.add_argument("--threads", type=int, default=16)
    s.add_argument("--opt", default="all")
    c = sub.add_parser("compare")
    c.add_argument("files", nargs="+")
    a = p.parse_args()
    score(a) if a.cmd == "score" else compare(a)


if __name__ == "__main__":
    main()
