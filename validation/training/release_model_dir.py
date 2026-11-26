"""Assemble the model export that scripts/publish-assets.mjs stages for assets-v2 (docs/validation.md, "Training round 1").

  python3 -I validation/training/release_model_dir.py --export EXPORT_DIR --weights MODEL.safetensors --shipped SHIPPED_DIR --out OUT_DIR

OUT_DIR gets onnx/model.int8.onnx (the exported graph, copied), model_metadata.json (the export's inference metadata
with a truthful revision and provenance: model_revision is "sha256:" + the SHA-256 of the trained safetensors, the
convention of sense-model's trainer), and calibration.json, tokenizer.json and tokenizer_config.json copied from the
shipped export: the calibration is the same identity file, and the tokenizer files give the same token ids (checked).
Refuses an existing OUT_DIR.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--export", required=True)
p.add_argument("--weights", required=True, help="the trained model.safetensors the graph was exported from")
p.add_argument("--shipped", required=True, help="the assets-v1 model export (calibration and tokenizer files)")
p.add_argument("--out", required=True)
a = p.parse_args()
export, shipped, out = Path(a.export), Path(a.shipped), Path(a.out)
out.mkdir(parents=True)
(out / "onnx").mkdir()
shutil.copyfile(export / "onnx" / "model.int8.onnx", out / "onnx" / "model.int8.onnx")
digest = hashlib.sha256()
with open(a.weights, "rb") as f:
    for block in iter(lambda: f.read(1 << 20), b""):
        digest.update(block)
meta = json.loads((export / "model_metadata.json").read_text())
base = json.loads((shipped / "model_metadata.json").read_text())
assert meta["letters"] == base["letters"] and meta["template_version"] == "compact-v1" and meta["nota_index"] == 127
recipe = json.loads((export / "recipe.json").read_text())
meta["model_revision"] = "sha256:" + digest.hexdigest()
meta["base_model"] = "sign/Ettin-150m-WSD"
meta["base_revision"] = base["model_revision"]
meta["training"] = {
    "round": "contextual-dictionary training round 1, run s2-labels-teacher (docs/validation.md)",
    "labels": "English Wiktionary usage examples and quotations with the meaning their editors attached them to, Kaikki.org extract of 2026-10-30",
    "teacher": "sign/Ettin-1B-WSD revision e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc, soft labels at temperature 2 on those examples and on English Wikipedia paragraphs (wikimedia/wikipedia 20231101.en, file train-00001-of-00041, revision b04c8d1ceb2f5cd4588862100d08de323dccfbaa)",
    "loss": "0.3 label cross-entropy (label smoothing 0.1) + 0.7 x T^2 x KL to the teacher, T = 2; learning rate 5e-5 (cosine), batch 64, seed 42",
    "steps": "planned 3 epochs (8,715 steps); early stopping on development accuracy (patience 4 evaluations of 300 steps) ended it at step 4,200; this is the step-3,000 checkpoint (1.03 epochs), the best on development",
}
meta["export"] = {
    "graph": "dynamic quantization, INT8 weights per channel for MatMul, activations uint8 at run time",
    "float_matmuls": recipe["excluded_nodes"],
    "token_embedding": "float16, cast to float at session creation",
}
(out / "model_metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
for name in ("calibration.json", "tokenizer.json", "tokenizer_config.json"):
    shutil.copyfile(shipped / name, out / name)
print(json.dumps({k: v for k, v in meta.items() if k != "letters"}, indent=1))
