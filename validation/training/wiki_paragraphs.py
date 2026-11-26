"""Seeded sample of plain paragraphs from one English Wikipedia parquet shard (unlabelled stream).

Source: https://huggingface.co/datasets/wikimedia/wikipedia, revision b04c8d1ceb2f5cd4588862100d08de323dccfbaa,
file 20231101.en/train-00001-of-00041.parquet (sha256 6cd57a58...e36cf), CC BY-SA 3.0 / GFDL.
Keeps paragraphs of 120-700 characters that look like prose (no list/table markup, mostly letters), at most
--per-article per article, then a seeded sample of --n paragraphs.
  venv/bin/python -I wiki_paragraphs.py SHARD OUT.jsonl --n 60000
"""
import argparse
import hashlib
import json
import re

import pyarrow.parquet as pq

p = argparse.ArgumentParser()
p.add_argument("shard")
p.add_argument("out")
p.add_argument("--n", type=int, default=60000)
p.add_argument("--per-article", type=int, default=3)
p.add_argument("--seed", default="cd-wiki-r1")
a = p.parse_args()

table = pq.read_table(a.shard, columns=["id", "title", "text"])
rows = []
for doc, title, text in zip(*(table.column(c).to_pylist() for c in ("id", "title", "text"))):
    kept = 0
    for i, para in enumerate(text.split("\n")):
        para = para.strip()
        if not 120 <= len(para) <= 700 or kept >= a.per_article:
            continue
        letters = sum(ch.isalpha() for ch in para)
        if letters / len(para) < 0.75 or re.search(r"[|{}=<>\[\]]", para) or para.endswith(":") or "*" in para:
            continue
        rank = hashlib.sha256(f"{a.seed}\n{doc}\n{i}".encode()).hexdigest()
        rows.append((rank, {"doc": doc, "title": title, "para": i, "text": para}))
        kept += 1
rows.sort(key=lambda r: r[0])
with open(a.out, "w", encoding="utf-8") as f:
    for _, row in rows[: a.n]:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"{table.num_rows} articles, {len(rows)} usable paragraphs, wrote {min(a.n, len(rows))}")
