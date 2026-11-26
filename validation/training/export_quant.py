"""Export a trained checkpoint to ONNX and apply the recommended quantization recipe, adjusted to its own outlier layers.

1. outlier layers: mlp.Wo Linears whose input max / 99.9th percentile exceeds --ratio (act_stats_model.py output);
2. float export with sense-model's own exporter (wsd.export.export_model: opset 17, parity check against PyTorch on the
   smoke fixtures) into OUT/ (model files, tokenizer, metadata, onnx/model.onnx, parity.json);
3. quantize_dynamic(per_channel=True, weight_type=QInt8, op_types_to_quantize=["MatMul"], nodes_to_exclude=those mlp.Wo
   MatMuls), then the token embedding stored as float16 with a Cast back to float: OUT/onnx/model.int8.onnx.
Writes OUT/recipe.json (layers, options, sizes).
  venv/bin/python -I export_quant.py --model CKPT --act-stats STATS.jsonl --out OUT
"""
import argparse
import json
import gzip
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "src/sense-model/src"))
import numpy as np  # noqa: E402
import onnx  # noqa: E402
from onnx import helper, numpy_helper  # noqa: E402

FIXTURES = Path.home() / "src/sense-model/data/fixtures/smoke.jsonl"

p = argparse.ArgumentParser()
p.add_argument("--model", required=True)
p.add_argument("--act-stats", required=True)
p.add_argument("--out", required=True)
p.add_argument("--ratio", type=float, default=15.0)
a = p.parse_args()
out = Path(a.out)

stats = [json.loads(l) for l in Path(a.act_stats).read_text().splitlines() if l]
layers = sorted(int(r["name"].split(".")[2]) for r in stats if r["name"].endswith("mlp.Wo") and r["outlier_ratio"] > a.ratio)
print("outlier mlp.Wo layers:", layers, flush=True)

if not (out / "onnx" / "model.onnx").exists():
    from wsd.data import read_jsonl
    from wsd.export import export_model
    from wsd.predict import Predictor

    predictor = Predictor.from_pretrained(a.model, device="cpu")
    report = export_model(predictor, read_jsonl(FIXTURES), out, quantize=False)
    print("float parity:", [c["max_logit_error"] for c in report["float_parity"]], flush=True)

from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402

tmp = out / "onnx" / "model.pc-int8.onnx"
exclude = [f"/model/model/layers.{i}/mlp/Wo/MatMul" for i in layers]
names = {n.name for n in onnx.load(str(out / "onnx" / "model.onnx"), load_external_data=False).graph.node}
missing = [n for n in exclude if n not in names]
if missing:
    raise SystemExit(f"node names not in the graph: {missing}")
quantize_dynamic(str(out / "onnx" / "model.onnx"), str(tmp), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"],
                 per_channel=True, nodes_to_exclude=exclude)
model = onnx.load(str(tmp))
g = model.graph
name = "model.model.embeddings.tok_embeddings.weight"
init = next(i for i in g.initializer if i.name == name)
half = numpy_helper.from_array(numpy_helper.to_array(init).astype(np.float16), name + "_fp16")
g.initializer.remove(init)
g.initializer.append(half)
g.node.insert(0, helper.make_node("Cast", [half.name], [name], to=onnx.TensorProto.FLOAT, name=name + "_cast"))
final = out / "onnx" / "model.int8.onnx"
onnx.save(model, str(final))
tmp.unlink()
data = final.read_bytes()
recipe = {"model": a.model, "outlier_rule": f"mlp.Wo input max/p99.9 > {a.ratio}", "outlier_layers": layers, "excluded_nodes": exclude,
          "quantize_dynamic": {"weight_type": "QInt8", "per_channel": True, "op_types_to_quantize": ["MatMul"]},
          "token_embedding": "float16 + Cast", "stored_bytes": len(data), "gzip6_bytes": len(gzip.compress(data, 6))}
(out / "recipe.json").write_text(json.dumps(recipe, indent=1))
print(json.dumps(recipe, indent=1))
