"""Batched PyTorch scorer for compact-v1 prompts (teacher soft labels, student evaluation).

Same output lines as teacher/scripts/score_pt.py (hash, type, code, logits = offered meanings then "none of the
above", ms, tokens, offered, threads). Prompts are sorted by length and batched under a token budget with padding
and an attention mask; resumable (hashes already in --out are skipped). Over 2048 tokens: rejected TOO_LONG.
  venv/bin/python -I score_batch.py --model DIR --prompts FILE[,FILE] --out FILE [--hashes FILE] [--dtype float32|bfloat16] [--max-tokens 32768]
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
import torch  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402
from wsd.model import WSDModernBertForMaskedLM  # noqa: E402


def jsonl(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l]


def load(model_dir, dtype, device="cuda"):
    tok = Tokenizer.from_file(str(Path(model_dir) / "tokenizer.json"))
    tok.no_truncation()
    tok.no_padding()
    model = WSDModernBertForMaskedLM.from_pretrained(str(model_dir), attn_implementation="sdpa", dtype=dtype).to(device).eval()
    assert model.decoder.out_features == 128
    return tok, model


@torch.inference_mode()
def logits_for(model, batch_ids, mask_id, pad_id, device="cuda"):
    width = max(len(ids) for ids in batch_ids)
    ids = torch.full((len(batch_ids), width), pad_id, dtype=torch.long)
    att = torch.zeros((len(batch_ids), width), dtype=torch.long)
    pos = torch.zeros(len(batch_ids), dtype=torch.long)
    for i, row in enumerate(batch_ids):
        ids[i, : len(row)] = torch.tensor(row)
        att[i, : len(row)] = 1
        pos[i] = row.index(mask_id)
    return model(input_ids=ids.to(device), attention_mask=att.to(device), prediction_positions=pos.to(device)).logits.float().cpu()


def safe_logits(model, batch_ids, mask_id, pad_id):
    """logits_for, splitting the batch in halves on CUDA out-of-memory (results are per row, so unchanged)."""
    try:
        return logits_for(model, batch_ids, mask_id, pad_id)
    except (torch.OutOfMemoryError, torch.AcceleratorError) as err:
        if "out of memory" not in str(err) or len(batch_ids) == 1:
            raise
        torch.cuda.empty_cache()
        half = len(batch_ids) // 2
        return torch.cat([safe_logits(model, batch_ids[:half], mask_id, pad_id), safe_logits(model, batch_ids[half:], mask_id, pad_id)])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True)
    p.add_argument("--prompts", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--hashes")
    p.add_argument("--dtype", default="float32", choices=["float32", "bfloat16"])
    p.add_argument("--max-tokens", type=int, default=32768)
    p.add_argument("--max-batch", type=int, default=64)
    p.add_argument("--label", default="batch")
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    prompts = {}
    for f in a.prompts.split(","):
        for r in jsonl(f):
            prompts[r["hash"]] = r
    wanted = [h for h in Path(a.hashes).read_text().split() if h] if a.hashes else list(prompts)
    out = Path(a.out)
    done = set()
    if out.exists():
        # A process killed mid-write leaves a partial last line: cut it so appending resumes cleanly.
        data = out.read_bytes()
        if data and not data.endswith(b"\n"):
            out.write_bytes(data[: data.rfind(b"\n") + 1])
        for line in out.read_text(encoding="utf-8").splitlines():
            try:
                done.add(json.loads(line)["hash"])
            except (ValueError, KeyError):
                pass
    todo = [h for h in dict.fromkeys(wanted) if h not in done]
    if a.limit:
        todo = todo[: a.limit]
    dtype = torch.float32 if a.dtype == "float32" else torch.bfloat16
    tok, model = load(a.model, dtype)
    mask_id, pad_id = tok.token_to_id("[MASK]"), tok.token_to_id("[PAD]")
    enc = {h: tok.encode(prompts[h]["prompt"]).ids for h in todo}
    order = sorted(todo, key=lambda h: len(enc[h]))
    print(f"{len(todo)} to score ({len(done)} done), {a.dtype}", file=sys.stderr, flush=True)
    started = time.time()
    n = 0
    with out.open("a", encoding="utf-8") as stream:
        i = 0
        while i < len(order):
            h = order[i]
            if len(enc[h]) > 2048 or enc[h].count(mask_id) != 1:
                code = "TOO_LONG" if len(enc[h]) > 2048 else "MASK"
                stream.write(json.dumps(dict(hash=h, type="rejected", code=code, logits=None, ms=0, tokens=len(enc[h]), offered=prompts[h]["offered"], threads=a.label)) + "\n")
                i += 1
                continue
            j = i
            while j < len(order) and j - i < a.max_batch and len(enc[order[j]]) <= 2048 and (j - i + 1) * len(enc[order[j]]) <= a.max_tokens:
                j += 1
            j = max(j, i + 1)
            batch = order[i:j]
            t0 = time.perf_counter()
            rows = safe_logits(model, [enc[x] for x in batch], mask_id, pad_id)
            ms = (time.perf_counter() - t0) * 1000 / len(batch)
            for x, row in zip(batch, rows.tolist()):
                off = prompts[x]["offered"]
                stream.write(json.dumps(dict(hash=x, type="scored", code=None, logits=row[:off] + [row[127]], ms=round(ms, 2), tokens=len(enc[x]), offered=off, threads=a.label)) + "\n")
            n += len(batch)
            i = j
            if n and n % 2000 < len(batch):
                el = time.time() - started
                print(f"{n}/{len(todo)} {el / 60:.1f} min, {n / el:.1f} prompts/s", file=sys.stderr, flush=True)
    el = time.time() - started
    print(f"scored {n} in {el / 60:.1f} min, {n / max(el, 1e-9):.1f} prompts/s", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
