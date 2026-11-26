"""Peak GPU memory and time of one training step on the longest stage 2 prompts (no text printed).

Builds micro-batches of the N longest training prompts (padded to the longest, 1,858 tokens) and runs forward,
the choice loss and backward under bf16 autocast, with and without gradient checkpointing; also one teacher bf16
inference batch at the scorer's token budget.
  venv/bin/python -I mem_probe.py
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
import torch  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402
from wsd.model import WSDModernBertForMaskedLM  # noqa: E402
from wsd.train import choice_loss  # noqa: E402

T = Path.home() / ".cache/contextual-dictionary/validation/train"
STUDENT = Path.home() / "src/sense-model/artifacts/upstream-english"
TEACHER = Path.home() / ".cache/contextual-dictionary/validation/teacher/model/Ettin-1B-WSD"
tok = Tokenizer.from_file(str(STUDENT / "tokenizer.json"))
mask = tok.token_to_id("[MASK]")
prompts = [json.loads(l) for f in ("train-prompts.jsonl", "unlabelled-prompts.jsonl") for l in open(T / "data" / f)]
longest = sorted(prompts, key=lambda r: -r["tokens"])[:64]
enc = [tok.encode(r["prompt"]).ids for r in longest]


def batch(n):
    rows = enc[:n]
    w = max(len(r) for r in rows)
    ids = torch.full((n, w), tok.token_to_id("[PAD]"))
    att = torch.zeros((n, w), dtype=torch.long)
    pos = torch.tensor([r.index(mask) for r in rows])
    for i, r in enumerate(rows):
        ids[i, : len(r)] = torch.tensor(r)
        att[i, : len(r)] = 1
    return ids.cuda(), att.cuda(), pos.cuda(), w


def train_step(n, checkpointing):
    model = WSDModernBertForMaskedLM.from_pretrained(str(STUDENT), attn_implementation="sdpa", dtype=torch.float32).cuda().train()
    if checkpointing:
        model.gradient_checkpointing_enable()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-6)
    ids, att, pos, w = batch(n)
    labels = torch.zeros(n, 128)
    labels[:, 0] = 1
    valid = torch.zeros(n, 128, dtype=torch.bool)
    valid[:, :25] = True
    valid[:, 127] = True
    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    for _ in range(2):
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits = model(input_ids=ids, attention_mask=att, prediction_positions=pos).logits
        loss, _ = choice_loss(logits, labels.cuda(), valid.cuda(), smoothing=0.1)
        loss.backward()
        opt.step()
        opt.zero_grad()
    torch.cuda.synchronize()
    r = dict(kind="train", micro_batch=n, tokens=w, checkpointing=checkpointing, peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2),
             reserved_gb=round(torch.cuda.max_memory_reserved() / 2**30, 2), s_per_step=round((time.time() - t0) / 2, 2))
    del model, opt
    torch.cuda.empty_cache()
    return r


results = []
for n, ck in ((4, False), (8, False), (8, True), (16, True)):
    try:
        results.append(train_step(n, ck))
    except torch.OutOfMemoryError:
        results.append(dict(kind="train", micro_batch=n, checkpointing=ck, peak_gb="OOM"))
        torch.cuda.empty_cache()
    print(json.dumps(results[-1]), flush=True)

teacher = WSDModernBertForMaskedLM.from_pretrained(str(TEACHER), attn_implementation="sdpa", dtype=torch.bfloat16).cuda().eval()
for budget in (8192, 16384):
    n = max(1, budget // 1858)
    ids, att, pos, w = batch(n)
    torch.cuda.reset_peak_memory_stats()
    with torch.inference_mode():
        teacher(input_ids=ids, attention_mask=att, prediction_positions=pos)
    torch.cuda.synchronize()
    print(json.dumps(dict(kind="teacher-bf16", token_budget=budget, batch=n, tokens=w, peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2),
                          reserved_gb=round(torch.cuda.max_memory_reserved() / 2**30, 2))), flush=True)
