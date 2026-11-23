# Model runtime under WebAssembly: first measurements

The first read on the project's biggest risk (plan section 9): how fast the
real Ettin-150m-WSD INT8 checkpoint runs with `onnxruntime-web` 1.30.0 on
WebAssembly in Chromium. These numbers are from one machine on one day. They
are a stage 1 read for planning, not the stage 3 validation.

## Result in brief

- The real checkpoint loads and orders by context under WebAssembly, both on a
  cross-origin isolated test page and inside the built extension (an extension
  page and its model worker are cross-origin isolated, so threads work there).
  "mouse" in "Drag the mouse to move the cursor on screen" ranks the pointing
  device first, ahead of the rodent. "bank" ranks the river bank first in a river
  sentence and the financial institution first in a salary sentence.
- Cold load: about 1.6–1.8 s from posting the 267 MB model to the worker until
  `ready`, which includes creating the session and the two warm-up prompts, plus
  0.7–0.9 s to read the files over loopback HTTP on the test page. Memory for the
  page and its worker is about 760 MB once loaded (`measureUserAgentSpecificMemory`).
- Warm latency with 8 threads is about **3× native for short inventories and
  5–7× native for long ones**: about 105 ms for 6 meanings, 190 ms for 12,
  445 ms for 24, 1.3–1.8 s for 48 and 4–6 s for 100. Time grows faster than
  the token count.
- With the default 350 ms budget, a ready model orders words with up to about 18–20
  meanings of this length. The default `maxCandidates` of 48 is far above what
  the budget allows; larger inventories get dictionary order first and the late
  answer only on a repeat lookup. Stage 3 should revisit both defaults (plan
  section 3), and consider a cap by tokens rather than by meanings.
- INT8 quantised operators work and help: the fp32 export of the same checkpoint
  is about 1.4–2.6× slower under WebAssembly than the INT8 run just before it.

## Method

- `test/e2e/model-real.spec.ts`, which is skipped unless `CD_TEST_MODEL_DIR` is set:

  ```bash
  npm run build
  CD_TEST_MODEL_DIR=~/src/sense-model/artifacts/upstream-english npx playwright test model-real
  CD_TEST_MODEL_BENCH=1 CD_TEST_MODEL_DIR=~/src/sense-model/artifacts/upstream-english npx playwright test model-real -g measures
  ```

- A loopback HTTP server serves a test page, the built `dist/model-worker.js`,
  `dist/ort/` and the model files with `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin`. The page fetches the five files,
  starts the worker as a module worker, and posts the `load` message with the
  model buffer transferred.
- **Load time** is from posting `load` to receiving `ready`. **Warm latency** is
  from posting one `score` message to receiving `scored`, as the ranker sees it
  (tokenisation, the run, copying 128 logits, and two worker messages). Each
  inventory is scored once untimed, then 7 times (3 times for 1 thread with 48 or
  100 meanings); the table gives the median and the range.
- Prompts are compact-v1 prompts built by hand, as `senseRequest` builds them:
  a passage around "run" with the target in `*`, *n* meanings of "run" written at
  Wiktionary length (about 15 tokens each, cycled for the larger inventories),
  "none of the above", the separator and the mask. Latency depends on the token
  count, so the table gives it.
- The test of the extension itself copies `dist/` to a temporary directory, puts
  the model files beside it, loads it as an unpacked extension and runs the same
  load and a "mouse" prompt from `popup.html`. It checks that both the page and
  the worker report `crossOriginIsolated`.

## Machine

12th Gen Intel Core i9-12900F, 24 logical cores, 31 GB, Windows with WSL2
(Linux 6.18), Chromium 159.0.8154.6 headless (Playwright 1.65.1),
`onnxruntime-web` 1.30.0 (`ort-wasm-simd-threaded`). Other agents were building
and testing on the same machine during the runs (load average 4–11), so the
numbers are noisy; the two 8-thread runs below differ by up to 45% at 48 and 100
meanings.

## Numbers

Load (int8, from `load` to `ready`): 1.82 s and 1.57 s with 8 threads, 3.62 s
with 4, 2.15 s with 1. The 4-thread figure coincided with a slow file read (2.4 s)
and is probably load from other work.

Warm latency, INT8, two runs with 8 threads and one each with 4 and 1:

| Meanings | Tokens | 8 threads, run 1 | 8 threads, run 2 | 4 threads | 1 thread |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 6 | 108 | 107 ms (103–122) | 110 ms (95–115) | 145 ms (126–178) | 386 ms (381–395) |
| 12 | 205 | 196 ms (170–229) | 189 ms (177–201) | 355 ms (319–431) | 763 ms (742–766) |
| 24 | 388 | 448 ms (434–516) | 443 ms (405–544) | 545 ms (529–768) | 1,636 ms (1,603–1,690) |
| 48 | 746 | 1,848 ms (1,775–2,314) | 1,271 ms (1,181–1,417) | 1,438 ms (1,433–1,633) | 4,027 ms (3,941–4,078) |
| 100 | 1,521 | 5,959 ms (5,448–6,925) | 4,045 ms (3,646–4,476) | 4,404 ms (4,110–5,707) | 10,974 ms (10,919–11,305) |

The same prompts on the fp32 export (`onnx/model.onnx`, 600 MB, 8 threads, load
2.31 s, about 1,485 MB of memory): 229, 495, 834, 1,860 and 5,503 ms.

Native `onnxruntime-node` for comparison (pdfpal's guide, WSL2 on a 24-thread CPU, 8 threads,
WordNet inventories): 35–55 ms for 6–11 meanings, 135–150 ms for 21–22, about
240 ms for 40.

## Notes

- Threads help about 3.5× from 1 to 8 for short prompts and less for long ones;
  4 and 8 threads are close for long prompts on this busy machine. The default
  of half the logical cores, at most 8 (`defaultThreads()` in `src/model/load.ts`),
  stays.
- Without cross-origin isolation ONNX Runtime warns and falls back to one thread,
  which is the 1-thread column. The real-model test fails if it sees that warning.
- `int64` input tensors (`BigInt64Array`) work in `onnxruntime-web` as they do
  natively.
- The worker uses the WebAssembly-only build of ONNX Runtime with its loader kept
  outside the bundle (`onnxruntime-web-use-extern-wasm` condition in
  `scripts/build.mjs`). The bundled variant would start its thread workers from
  `model-worker.js` itself.
- Not measured here: p90/p99 over many passages, memory over time, the first
  lookup after a cold load, behaviour on smaller machines. Those belong to stage 3.
