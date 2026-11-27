"""Assembles the dataset andrepaim/wiktionary-wsd from the files training round 1 of Contextual Dictionary wrote.

  # 1. Entry headwords of every lookup (the extension's own lookup, rerun and checked against the stored prompts):
  cd ~/src/contextual-dictionary && CD_VALIDATION_OUT=$WORK/tmp npx tsx $DATASET/scripts/entry_lemmas.mts $WORK/lemmas-all.jsonl \
    $V/train/data/train-items.jsonl $V/train/data/dev-items.jsonl $V/train/data/unlabelled-items.jsonl \
    $V/wiktionary-items.jsonl $V/written-items.jsonl
  # 2. This script (Python 3.12 with pyarrow; it imports sense-model's wsd package and the extension's prepare_examples.py):
  $V/teacher/venv/bin/python -I $DATASET/scripts/assemble.py --out $DATASET --lemmas $WORK/lemmas-all.jsonl
  # where V=~/.cache/contextual-dictionary/validation, DATASET=~/.cache/contextual-dictionary/hf-upload/wiktionary-wsd,
  # WORK=~/.cache/contextual-dictionary/hf-upload/wiktionary-wsd-work

Inputs (read only): the builders' outputs under ~/.cache/contextual-dictionary/validation/ (docs/validation.md of
https://github.com/andrepaim/contextual-dictionary, "Training round 1 (assets-v2)"), the Kaikki.org English extract of
2026-10-30 (quotation references), the Wikipedia shard the paragraphs were sampled from (article titles and URLs), the
extension's repository (held-out lists, prepare_examples.py) and sense-model (wsd.schema, wsd.tokenizer.format_prompt,
wsd.data.read_jsonl).

What it writes under --out:
  data/, teacher/       the files the training runs read, copied byte for byte (same relative paths as under
                        validation/train/, so a rerun of validation/training/stage2.sh can point at this folder)
  eval/                 the three test sets as sense-model Examples in the two prompt forms that were scored, made from
                        the extension's prompts with prepare_examples.py's example_from_prompt (format_prompt must rebuild
                        each prompt byte for byte); the item files the scores were computed from; the held-out headwords
  sources/              one row per passage: its Wiktionary or Wikipedia page, and the pages of the entries whose
                        definitions were offered (attribution side tables; the training files are not changed)
  reports/              the builders' and the leak check's reports, local paths replaced by ~
  manifest.json         every file with its size, SHA-256, rows, origin and description
"""
import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

HOME = Path.home()
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
p.add_argument("--lemmas", required=True, help="output of entry_lemmas.mts")
p.add_argument("--validation", default=str(HOME / ".cache/contextual-dictionary/validation"))
p.add_argument("--repo", default=str(HOME / "src/contextual-dictionary"))
p.add_argument("--sense-model", default=str(HOME / "src/sense-model"))
p.add_argument("--kaikki", default=str(HOME / ".cache/contextual-dictionary/kaikki/english-2026-10-30.jsonl.gz"))
a = p.parse_args()
OUT, V, REPO, SM = Path(a.out), Path(a.validation), Path(a.repo), Path(a.sense_model)
T = V / "train"

sys.path.insert(0, str(SM / "src"))
sys.path.insert(0, str(REPO / "validation/training"))
from prepare_examples import example_from_prompt  # noqa: E402  (also puts sense-model's src on the path)
from wsd.data import read_jsonl  # noqa: E402
from wsd.schema import Example  # noqa: E402


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def jl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def expect(name, got, want):
    if got != want:
        raise SystemExit(f"count differs from docs/validation.md: {name}: {got} (documented {want})")
    print(f"ok {name}: {got}")


def page(site, title):
    return f"https://{site}/wiki/" + quote(title.replace(" ", "_"), safe="/_-.,:;'()!~*@")


WIKT = "en.wiktionary.org"
meta = {}  # path -> (origin, description)

# ---------------------------------------------------------------- 1. training files, byte for byte
COPIES = [
    ("data/train-labelled.clean.jsonl", "Labelled training examples (Wiktionary): gold_ids is the meaning the example is filed under. Both prompt forms; an item appears twice when the forms differ."),
    ("data/train-notoffered.clean.jsonl", "Teacher-only training examples (Wiktionary): prompts at the defaults whose cap left the labelled meaning out; gold_ids null, used with the teacher's answers only."),
    ("data/unlabelled.clean.jsonl", "Unlabelled training examples (English Wikipedia paragraphs), teacher only; gold_ids null."),
    ("data/dev-c1600.clean.jsonl", "Development examples at the extension's defaults (24|c1600), labelled meaning offered. Read by the runs (--dev)."),
    ("data/dev-127.clean.jsonl", "Development examples with every meaning (127), labelled meaning offered. Read by the runs (--dev127)."),
    ("data/dev-notoffered.clean.jsonl", "Development prompts at the defaults whose cap left the labelled meaning out (gold_ids null). Not read by the runs; counted as misses in the development tables."),
    ("data/dev-items.jsonl", "Development items in the extension's item format (analyze.ts), the input of dev_eval.py with reports/excluded-overlap-ids.txt."),
    ("teacher/cache-stage2-T2.jsonl", "The teacher's soft labels as the runs read them (--teacher-scores): example fingerprint, probabilities at T = 2 per candidate id and none of the above. sign/Ettin-1B-WSD, bf16."),
    ("teacher/teacher-bf16.jsonl", "The teacher's raw logits (offered meanings, then none of the above) per prompt SHA-256, bf16, for every training, unlabelled and development prompt."),
]
for rel, desc in COPIES:
    src, dst = T / rel, OUT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists() or dst.stat().st_size != src.stat().st_size or sha256(dst) != sha256(src):
        shutil.copyfile(src, dst)
    assert sha256(dst) == sha256(src), rel
    meta[rel] = (f"validation/train/{rel}", desc)

# Counts against docs/validation.md, read with sense-model's own reader.
ex = {rel: read_jsonl(OUT / rel) for rel, _ in COPIES if rel.endswith(".clean.jsonl")}
expect("labelled training examples", len(ex["data/train-labelled.clean.jsonl"]), 129_093)
expect("teacher-only training examples", len(ex["data/train-notoffered.clean.jsonl"]), 1_658)
expect("unlabelled examples", len(ex["data/unlabelled.clean.jsonl"]), 55_138)
excluded = set((T / "data/excluded-overlap-ids.txt").read_text().split())
dev_items = [it for it in jl(T / "data/dev-items.jsonl") if it["id"] not in excluded]
expect("development items", len(dev_items), 4_931)
cache_rows = sum(1 for _ in open(OUT / "teacher/cache-stage2-T2.jsonl", encoding="utf-8"))
expect("teacher cache rows (labelled + teacher-only + unlabelled)", cache_rows, 129_093 + 1_658 + 55_138)

# ---------------------------------------------------------------- 2. evaluation sets
SETS = {
    "wiktionary": {"source": "English Wiktionary (kaikki.org extract 2026-10-30)", "license": "CC BY-SA 4.0", "annotation": "human", "items": 2_300},
    "written": {"source": "Hand-written set of contextual-dictionary (validation/data/written-raw.tsv), written and labelled by a model, no human review; definitions from English Wiktionary (kaikki.org extract 2026-10-30)",
                "license": "passage MIT (contextual-dictionary repository); definitions CC BY-SA 4.0", "annotation": "synthetic", "items": 104},
    "simple": {"source": "Simple English Wiktionary (kaikki.org extract as served 2026-10-30)", "license": "CC BY-SA 4.0", "annotation": "human", "items": 4_167},
}
FORMS = {"24|c1600": "c1600", "127": "127"}
STRATA = [(1, 1, "1"), (2, 2, "2"), (3, 4, "3–4"), (5, 8, "5–8"), (9, 16, "9–16"), (17, 32, "17–32"), (33, 10**9, "33+")]
prompts = {r["hash"]: r for r in jl(V / "prompts.jsonl")}


def marked_target(prompt):
    """The target span of a prompt, from its two asterisks (code points). validation/prompts.jsonl stores no target, unlike
    the training prompt files; this rule gives the stored target for every one of the training round's 191,588 prompts."""
    points = list(prompt.split("\n")[0])
    stars = [i for i, ch in enumerate(points) if ch == "*"]
    assert len(stars) == 2, "the extension marks the target with exactly two asterisks"
    return {"start": stars[0], "end": stars[1] - 1, "text": "".join(points[stars[0] + 1 : stars[1]])}


for name in ["train-prompts", "dev-prompts", "unlabelled-prompts"]:
    for r in jl(T / f"data/{name}.jsonl"):
        assert marked_target(r["prompt"]) == r["target"], r["hash"]
print("ok marked_target equals the stored target of every training, development and unlabelled prompt")
test_hashes = set((T / "test-scores/test-hashes.txt").read_text().split())
eval_counts, eval_items, used_hashes = {}, {}, set()
for name, info in SETS.items():
    items = jl(V / f"{name}-items.jsonl")
    expect(f"{name} test items", len(items), info["items"])
    eval_items[name] = items
    (OUT / "eval/items").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(V / f"{name}-items.jsonl", OUT / f"eval/items/{name}-items.jsonl")
    assert sha256(OUT / f"eval/items/{name}-items.jsonl") == sha256(V / f"{name}-items.jsonl")
    meta[f"eval/items/{name}-items.jsonl"] = (f"validation/{name}-items.jsonl", f"The {name} test items in the extension's item format (analyze.ts, compare.py): selection, labelled entry and meaning, entry sizes, and per prompt form the prompt hash, candidates and whether the labelled meaning is offered. EVALUATION ONLY.")
    for form, short in FORMS.items():
        rows, c = [], Counter()
        for it in items:
            pc = it["perCap"][form]
            if "prompt" not in pc:
                c[f"no prompt ({pc['skip']})"] += 1
                continue
            pr = prompts[pc["prompt"]]
            used_hashes.add(pr["hash"])
            labelled = f"{it['labelled']['entry']}:{it['labelled']['sense']}"
            meanings = it["meanings"]
            prov = {"source": info["source"], "license": info["license"], "document_id": it["id"], "annotation": info["annotation"],
                    "variant": form, "prompt_sha256": pr["hash"], "split_group": it["word"], "evaluation_only": True, "eval_set": name,
                    "labelled_id": labelled, "labelled_offered": pc["labelledOffered"], "entry_senses": it["entrySenses"],
                    "meanings": meanings, "stratum": it.get("stratum") or next(lab for lo, hi, lab in STRATA if lo <= meanings <= hi), "pos": it["pos"],
                    "genre": it.get("genre")}
            gold = [labelled] if pc["labelledOffered"] else None
            target = marked_target(pr["prompt"])
            assert target["text"] == it["selection"]["text"], it["id"]
            e = example_from_prompt(f"{it['id']}|{form}", pr["prompt"], target, [f"{x}:{y}" for x, y in pc["candidates"]], gold, prov)
            rows.append(e.to_dict())
            c["examples"] += 1
            c["labelled meaning offered" if gold else "labelled meaning not offered (gold_ids null)"] += 1
        rel = f"eval/{name}-{short}.jsonl"
        write_jsonl(OUT / rel, rows)
        assert len(read_jsonl(OUT / rel)) == len(rows)
        eval_counts[rel] = dict(c)
        meta[rel] = (f"made from validation/{name}-items.jsonl and validation/prompts.jsonl", f"EVALUATION ONLY. The {name} test set as sense-model Examples, prompt form {form}; gold_ids is the labelled meaning when the prompt offers it, null otherwise (provenance.labelled_id always holds it).")
assert used_hashes == test_hashes, "the evaluation examples' prompts are not exactly the prompts the runs scored"
print("ok evaluation prompts equal test-hashes.txt:", len(used_hashes))

# Held-out headwords, by the rule of docs/validation.md ("Held out of training"; validation/training-items.ts heldOutHeadwords).
data_lines = lambda path: [l for l in Path(path).read_text(encoding="utf-8").split("\n") if l and not l.startswith("#")]
held = {l.split("\t")[0] for l in data_lines(REPO / "validation/data/wiktionary-items.tsv")[1:]} | {l.split("\t")[1] for l in data_lines(REPO / "validation/data/written-labels.tsv")}
held.discard("")
expect("held-out headwords", len(held), 2_197)
expect("held-out headwords from the Wiktionary set", len({it["word"] for it in eval_items["wiktionary"]}), 2_146)
(OUT / "eval/heldout-headwords.txt").write_text("".join(w + "\n" for w in sorted(held)), encoding="utf-8")
meta["eval/heldout-headwords.txt"] = ("validation/data/wiktionary-items.tsv (first column) and validation/data/written-labels.tsv (lemma column) of the extension's repository", "The 2,197 headwords no training or development example may be built for, in any part of speech (one per line, sorted).")

# ---------------------------------------------------------------- 3. checks on the published files
lemmas = {}
for r in jl(a.lemmas):
    if r["check"] != "ok":
        raise SystemExit(f"lookup not reproduced for {r['file']} {r['id']}: {r['check']}")
    lemmas[(r["file"], r["id"])] = r["entries"]
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"[^0-9a-z]+", " ", s.lower())).strip()
shingles = lambda s, n=10: {" ".join(w[i:i + n]) for w in [s.split()] for i in range(max(0, len(w) - n + 1))}
test_texts = [e["text"] for rel in eval_counts for e in jl(OUT / rel)]
test_norm = {norm(t) for t in test_texts}
test_sh = set().union(*(shingles(norm(t)) for t in test_texts))
checks = {}
train_items = {it["id"]: it for it in jl(T / "data/train-items.jsonl")}
unl_items = {it["id"]: it for it in jl(T / "data/unlabelled-items.jsonl")}
dev_all = {it["id"]: it for it in jl(T / "data/dev-items.jsonl")}
for rel in ["data/train-labelled.clean.jsonl", "data/train-notoffered.clean.jsonl", "data/unlabelled.clean.jsonl", "data/dev-c1600.clean.jsonl", "data/dev-127.clean.jsonl", "data/dev-notoffered.clean.jsonl"]:
    rows = ex[rel]
    file = "unlabelled-items.jsonl" if "unlabelled" in rel else "dev-items.jsonl" if rel.startswith("data/dev") else "train-items.jsonl"
    looked = [lemmas[(file, e.provenance["document_id"])] for e in rows]
    checks[rel] = {
        "examples": len(rows),
        "headword (split_group) held out": sum(e.provenance["split_group"] in held for e in rows),
        "an entry headword of the lookup held out": sum(any(x["lemma"] in held for x in l) for l in looked),
        "passage equal to a test passage (normalised)": sum(norm(e.text) in test_norm for e in rows),
        "passage sharing a run of ten words with a test passage": sum(bool(shingles(norm(e.text)) & test_sh) for e in rows),
        "local path in the file": (OUT / rel).read_text(encoding="utf-8").count(str(HOME)),
    }
train_words = {e.provenance["split_group"] for rel in ["data/train-labelled.clean.jsonl", "data/train-notoffered.clean.jsonl"] for e in ex[rel]}
dev_words = {e.provenance["split_group"] for rel in ["data/dev-c1600.clean.jsonl", "data/dev-127.clean.jsonl", "data/dev-notoffered.clean.jsonl"] for e in ex[rel]}
unl_lemmas = {x["lemma"] for e in ex["data/unlabelled.clean.jsonl"] for x in lemmas[("unlabelled-items.jsonl", e.provenance["document_id"])]}
checks["headwords in both training and development"] = len(train_words & dev_words)
checks["unlabelled entry headwords that are development headwords"] = len(unl_lemmas & dev_words)
checks["training headwords"], checks["development headwords"] = len(train_words), len(dev_words)
for rel, c in checks.items():
    print("check", rel, c)
bad = [k for rel, c in checks.items() if isinstance(c, dict) for k, v in c.items() if k != "examples" and v]
if bad or checks["headwords in both training and development"] or checks["unlabelled entry headwords that are development headwords"]:
    raise SystemExit(f"a leak check failed: {bad}")

# ---------------------------------------------------------------- 4. attribution side tables
# Quotation references from the Kaikki extract: the example is found in its record (kaikkiLine) by the first 16 hex
# digits of the SHA-256 of its text, the fourth field of the item id.
want = defaultdict(set)
wikt_rows = []  # (part, item)
train_docs = sorted({e.provenance["document_id"] for rel in ["data/train-labelled.clean.jsonl", "data/train-notoffered.clean.jsonl"] for e in ex[rel]})
for d in train_docs:
    wikt_rows.append(("train", train_items[d], "train-items.jsonl"))
for d, it in dev_all.items():
    wikt_rows.append(("dev", it, "dev-items.jsonl"))
for it in eval_items["wiktionary"]:
    wikt_rows.append(("test-wiktionary", it, "wiktionary-items.jsonl"))
for _, it, _ in wikt_rows:
    want[it["kaikkiLine"]].add(it["id"].split("|")[3])
KAIKKI_SHA = "4d03b6cba283744756c57ff661c2c6cbfe34fcf8ff513a966576cf7d97e91a99"
assert sha256(a.kaikki) == KAIKKI_SHA, "not the Kaikki extract of 2026-10-30"
refs, found = {}, Counter()
with gzip.open(a.kaikki, "rt", encoding="utf-8") as f:
    for n, line in enumerate(f, 1):
        if n not in want:
            continue
        rec = json.loads(line)
        for sense in rec.get("senses", []):
            for exm in sense.get("examples", []) or []:
                text = exm.get("text")
                if isinstance(text, str):
                    h = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
                    if h in want[n]:
                        refs[(n, h)] = exm.get("ref") if isinstance(exm.get("ref"), str) else None
entries_of = lambda l: [{"lemma": x["lemma"], "pos": x["pos"], "page": page(WIKT, x["lemma"])} for x in l]
rows = []
for part, it, file in wikt_rows:
    key = (it["kaikkiLine"], it["id"].split("|")[3])
    found["found" if key in refs else "not found"] += 1
    rows.append({"document_id": it["id"], "part": part, "headword": it["word"], "pos": it["pos"], "page": page(WIKT, it["word"]),
                 "kaikki_line": it["kaikkiLine"], "example_type": it["exampleType"], "year": it.get("year"),
                 "quotation_ref": refs.get(key), "entries": entries_of(lemmas[(file, it["id"])])})
if found["not found"]:
    raise SystemExit(f"examples not found in the Kaikki extract: {found}")
write_jsonl(OUT / "sources/wiktionary.jsonl", rows)
meta["sources/wiktionary.jsonl"] = ("made from the item files, the Kaikki extract and a rerun of the extension's lookup (entry_lemmas.mts)", "One row per Wiktionary passage (training, development, Wiktionary test set), keyed by document_id: its Wiktionary page, line of the Kaikki extract, quotation reference, and the page of every entry whose definitions the prompts offer (candidate id e:s is meaning s of entries[e]).")

written = [{"document_id": it["id"], "part": "test-written", "headword": it["word"], "pos": it["pos"], "genre": it["genre"],
            "passage_source": "validation/data/written-raw.tsv, https://github.com/andrepaim/contextual-dictionary (MIT), written by a model",
            "entries": entries_of(lemmas[("written-items.jsonl", it["id"])])} for it in eval_items["written"]]
write_jsonl(OUT / "sources/written.jsonl", written)
meta["sources/written.jsonl"] = ("made from validation/written-items.jsonl and a rerun of the extension's lookup", "One row per hand-written test item: where the sentence comes from, and the Wiktionary page of every entry whose definitions the prompts offer.")

simple = [{"document_id": it["id"], "part": "test-simple", "headword": it["word"], "pos": it["pos"], "page": page("simple.wiktionary.org", it["word"]),
           "simple_line": it["simpleLine"], "definition_in_english_wiktionary": it["definitionInEnglish"]} for it in eval_items["simple"]]
write_jsonl(OUT / "sources/simple.jsonl", simple)
meta["sources/simple.jsonl"] = ("made from validation/simple-items.jsonl", "One row per Simple English Wiktionary test item: its page (the example and every definition offered come from the entries of that one page), and its line in the Simple English Kaikki extract.")

import pyarrow.parquet as pq  # noqa: E402
SHARD_SHA = "6cd57a5825312ca966313d4a1b614690b5c4fb53cee9b124bc0e999977eb36cf"
assert sha256(T / "wiki/train-00001-of-00041.parquet") == SHARD_SHA, "not the documented Wikipedia shard"
shard = pq.read_table(T / "wiki/train-00001-of-00041.parquet", columns=["id", "url", "title"])
articles = {i: (u, t) for i, u, t in zip(*(shard.column(c).to_pylist() for c in ("id", "url", "title")))}
paras = {(r["doc"], r["para"]): r for r in jl(T / "data/wiki-paragraphs.jsonl")}
wiki = []
for d in sorted({e.provenance["document_id"] for e in ex["data/unlabelled.clean.jsonl"]}, key=lambda s: [int(x) if x.isdigit() else x for x in s.split("|")]):
    _, doc, para, start = d.split("|")
    url, title = articles[doc]
    assert paras[(doc, int(para))]["title"] == title
    wiki.append({"document_id": d, "wikipedia_id": doc, "title": title, "url": url, "paragraph": int(para), "char_offset": int(start),
                 "dump": "20231101.en", "entries": entries_of(lemmas[("unlabelled-items.jsonl", d)])})
write_jsonl(OUT / "sources/wikipedia.jsonl", wiki)
meta["sources/wikipedia.jsonl"] = ("made from validation/train/data/wiki-paragraphs.jsonl, the Wikipedia shard and a rerun of the extension's lookup", "One row per Wikipedia passage of the unlabelled stream: the article's id, title and URL in the shard, the paragraph index (split on newlines) and the target's offset in it, and the Wiktionary page of every entry whose definitions the prompts offer.")

# ---------------------------------------------------------------- 5. reports, local paths replaced by ~
for src, rel, desc in [
    (T / "data/build.json", "reports/build-train.json", "Report of validation/build-train-set.ts: counts of every rule (before the leak check)."),
    (T / "data/unlabelled-build.json", "reports/build-unlabelled.json", "Report of validation/build-unlabelled-set.ts."),
    (T / "data/leak-report.json", "reports/leak-report.json", "Report of validation/training/check_leaks.py on the builders' items."),
    (V / "wiktionary-build.json", "reports/build-wiktionary-test.json", "Report of validation/build-wiktionary-set.ts (the Wiktionary test set)."),
    (V / "simple-build.json", "reports/build-simple-test.json", "Report of validation/build-simple-set.ts (the Simple English Wiktionary test set)."),
    (T / "data/excluded-overlap-ids.txt", "reports/excluded-overlap-ids.txt", "The 605 item ids dropped because their passage equals or shares a run of ten words with a test passage (check_leaks.py)."),
]:
    text = src.read_text(encoding="utf-8").replace(str(HOME), "~")
    (OUT / rel).parent.mkdir(parents=True, exist_ok=True)
    (OUT / rel).write_text(text, encoding="utf-8")
    meta[rel] = (str(src).replace(str(HOME), "~").replace("~/.cache/contextual-dictionary/", ""), desc + (" Local paths replaced by ~." if str(HOME) in src.read_text(encoding="utf-8") else ""))
(OUT / "reports/assembly-checks.json").write_text(json.dumps({"checks": checks, "evaluation": eval_counts, "kaikki_examples_found": dict(found)}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
meta["reports/assembly-checks.json"] = ("written by scripts/assemble.py", "The checks this script ran on the published files (leaks, held-out headwords, local paths) and the evaluation examples' counts.")

# ---------------------------------------------------------------- 6. manifest
for rel in ["scripts/assemble.py", "scripts/entry_lemmas.mts"]:
    meta[rel] = ("this repository", "The assembly script (command at the top)." if rel.endswith(".py") else "Reruns the extension's lookup to recover each entry's headword (step 1 of assemble.py).")
git = lambda repo: subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
files = []
for rel, (origin, desc) in sorted(meta.items()):
    path = OUT / rel
    rows = sum(1 for line in open(path, encoding="utf-8") if line.strip()) if rel.endswith((".jsonl", ".txt")) else None
    files.append({"path": rel, "bytes": path.stat().st_size, "sha256": sha256(path), "rows": rows, "origin": origin, "description": desc})
manifest = {"dataset": "andrepaim/wiktionary-wsd", "assembled_from": {"contextual-dictionary": git(REPO), "sense-model": git(SM),
            "kaikki_english_extract": {"file": Path(a.kaikki).name, "sha256": KAIKKI_SHA},
            "wikipedia_shard": {"repo": "wikimedia/wikipedia", "revision": "b04c8d1ceb2f5cd4588862100d08de323dccfbaa", "file": "20231101.en/train-00001-of-00041.parquet", "sha256": SHARD_SHA}},
            "files": files}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
for f in files:
    print(f"{f['bytes']:>12} {f['sha256'][:16]} {str(f['rows']):>8} {f['path']}")
