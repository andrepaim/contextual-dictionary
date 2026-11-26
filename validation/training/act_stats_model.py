"""(train copy: --model and --prompts are parameters; prompts are development prompts.) Per-Linear quantization error of the student, in PyTorch on development prompts.

For each nn.Linear input: max |x|, the ratio of max |x| to its 99.9th percentile (outliers), and the relative RMS
error of ONNX Runtime's dynamic activation quantization (per tensor, asymmetric uint8 with the range forced to include 0).
For each weight: relative RMS error of symmetric int8 per tensor (what quantize_dynamic does by default) and per
output channel.
  venv/bin/python -I act_stats.py --n 200 --out FILE
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
import torch  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402
from wsd.model import WSDModernBertForMaskedLM  # noqa: E402

Q = Path.home() / ".cache/contextual-dictionary/validation/quant"
MODEL = None  # set from --model


def dq_uint8(x):
    lo, hi = min(x.min().item(), 0.0), max(x.max().item(), 0.0)
    scale = (hi - lo) / 255 or 1.0
    zp = round(-lo / scale)
    q = torch.clamp(torch.round(x / scale) + zp, 0, 255)
    return (q - zp) * scale


def rel(err, x):
    return (err.pow(2).mean().sqrt() / x.pow(2).mean().sqrt()).item()


def w_int8(w, per_channel):
    # nn.Linear weight is (out, in); ONNX MatMul B is (in, out) and per-channel axis is the output column
    m = w.abs().amax(dim=1, keepdim=True) if per_channel else w.abs().max()
    scale = m / 127
    return torch.clamp(torch.round(w / scale), -127, 127) * scale


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=200)
    p.add_argument("--out", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--prompts", default=str(Path.home() / ".cache/contextual-dictionary/validation/train/data/dev-prompts.jsonl"))
    a = p.parse_args()
    global MODEL
    MODEL = Path(a.model)
    prompts = {json.loads(l)["hash"]: json.loads(l) for l in Path(a.prompts).read_text().splitlines() if l}
    hashes = sorted(prompts)[: a.n]
    tok = Tokenizer.from_file(str(MODEL / "tokenizer.json"))
    mask = tok.token_to_id("[MASK]")
    model = WSDModernBertForMaskedLM.from_pretrained(str(MODEL), attn_implementation="sdpa", dtype=torch.float32).cuda().eval()
    stats = defaultdict(lambda: defaultdict(list))
    names = {m: n for n, m in model.named_modules() if isinstance(m, torch.nn.Linear)}

    def hook(module, inputs, output):
        x = inputs[0].detach().float().reshape(-1)
        s = stats[names[module]]
        s["max"].append(x.abs().max().item())
        s["outlier"].append((x.abs().max() / torch.quantile(x.abs()[: 2_000_000], 0.999).clamp_min(1e-9)).item())
        s["act_err"].append(rel(dq_uint8(x) - x, x))

    for m in names:
        m.register_forward_hook(hook)
    with torch.inference_mode():
        for h in hashes:
            ids = tok.encode(prompts[h]["prompt"]).ids
            model(input_ids=torch.tensor([ids]).cuda(), attention_mask=torch.ones(1, len(ids), dtype=torch.long).cuda(),
                  prediction_positions=torch.tensor([ids.index(mask)]).cuda())
    rows = []
    for m, n in names.items():
        w = m.weight.detach().float()
        s = stats[n]
        mean = lambda k: sum(s[k]) / len(s[k])
        rows.append(dict(name=n, act_max_mean=mean("max"), act_max_max=max(s["max"]), outlier_ratio=mean("outlier"), act_rel_err=mean("act_err"),
                         w_rel_err_tensor=rel(w_int8(w, False) - w, w), w_rel_err_channel=rel(w_int8(w, True) - w, w)))
    Path(a.out).write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    print(f"{'linear':34s} {'act max':>9s} {'max/p99.9':>9s} {'act err':>8s} {'w err T':>8s} {'w err C':>8s}")
    for r in rows:
        print(f"{r['name']:34s} {r['act_max_mean']:9.1f} {r['outlier_ratio']:9.1f} {r['act_rel_err']:8.4f} {r['w_rel_err_tensor']:8.4f} {r['w_rel_err_channel']:8.4f}")


if __name__ == "__main__":
    main()
