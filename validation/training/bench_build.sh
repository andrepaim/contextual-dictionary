#!/bin/bash
# bench_build.sh WORKTREE OUT_DIR PORT: a measurement-only copy of the production build whose downloads come from a
# loopback server: the built files' release base URL is rewritten to http://127.0.0.1:PORT/releases, and the manifest's
# host permissions and connect-src gain loopback, exactly as scripts/build.mjs does for its end-to-end variant. The
# pins, the model worker and ONNX Runtime are the production ones. Never shipped.
set -euo pipefail
W=$1; OUT=$2; PORT=$3
cd "$W" && node scripts/build.mjs --outdir="$OUT" > /dev/null
BASE='https://github.com/andrepaim/contextual-dictionary/releases/download'
n=$(grep -l "$BASE" "$OUT"/*.js | wc -l)
[ "$n" -ge 1 ] || { echo "release base URL not found in the build"; exit 1; }
sed -i "s#$BASE#http://127.0.0.1:$PORT/releases#g" "$OUT"/*.js
python3 -I - "$OUT/manifest.json" <<'PY'
import json, re, sys
p = sys.argv[1]; m = json.load(open(p))
m["host_permissions"] = m.get("host_permissions", []) + ["http://127.0.0.1/*"]
csp = m["content_security_policy"]["extension_pages"]
m["content_security_policy"]["extension_pages"] = re.sub(r"connect-src ([^;]*)", lambda g: f"connect-src {g.group(1)} http://127.0.0.1:*", csp)
json.dump(m, open(p, "w"), indent=2)
PY
echo "built $OUT (base URL rewritten in $n files)"
