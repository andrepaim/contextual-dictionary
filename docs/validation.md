# Stage 3 validation

How fast the extension is in practice, how well the model orders Wiktionary's meanings, what defaults were chosen from those numbers, and what was fixed. Everything here was measured on 2026-11-23 with the real model (`assets-v1`), the real dictionary pack and production builds of the extension in Chromium. The scripts are in `validation/`; how to rerun each measurement is at the end.

## Answers in brief

- **Speed.** On the test machine with 8 threads, a definition alone takes about 8 ms (p90 10–12 ms) once the dictionary is open, and the first one of a browser session about 0.1 s (was 1 s). With "Order by context" on, a lookup of a word with several meanings is ordered in about 0.27 s at the median and 0.6 s at worst (p99 0.59 s, maximum 0.69 s on 2,287 prompts), because prompts are now limited to 1,600 characters; the card waits at most 750 ms. Common words with many meanings ("mouse", "bank", "fire", "string") take about 0.4–0.6 s from the double-click to the card. With 2 threads (a stand-in for a small machine) 67% of lookups are answered within 750 ms; the rest show dictionary order first and the ordered list on a repeat. The model is ready 2.6–3.0 s after ordering is turned on in a new session (1.3–1.4 s when its files were already checked), and the extension's process uses about 1 GB more memory while it is loaded.
- **Accuracy.** Yes, the model's order beats Wiktionary's order, clearly. On 2,300 items labelled by Wiktionary's own editors, with the shipped defaults, the labelled meaning is first in its entry 55.4% of the time with model order against 28.2% with dictionary order (paired 95% interval of the difference 24.8 to 29.7 points), and among the three meanings the card shows before "Show all meanings" 77.9% against 60.1%. On 104 hand-written web-style sentences: 64.4% against 26.9% first. It is better in every stratum and every part of speech. It is far from perfect: for entries with 17 or more meanings, the labelled meaning is first in under a third of cases.
- **Defaults.** "Order by context" is now on by default (the model still downloads only after the reader confirms it), `budgetMs` 750, `maxCandidates` 24, and a new prompt length limit of 1,600 characters.

## Method

### Machine and load

12th Gen Intel Core i9-12900F (8 performance and 8 efficiency cores, 24 logical processors), 31 GB, Windows with WSL2 (Linux 6.18), Chromium 159 headless from Playwright 1.65.1, Node v22.23.1, `onnxruntime-web` 1.30.0. This agent was the only one working on the machine; the load average was below 1.5 before most timed runs (runs that started higher are marked), and about 8.5 during the scoring runs, which is the runs' own eight WebAssembly threads. Activity on the Windows side cannot be seen from WSL. Times inside the browser use `performance.now()`; one early run that used the wall clock gave an impossible model-ready time of 0.5 s and a negative one, which WSL's clock corrections explain, so those runs are not used.

The extension picks half the logical cores, at most 8 (`defaultThreads()`), so 8 here. Runs with 4 and 2 threads stand in for smaller machines; they still run on this machine's fast cores, so they are optimistic.

### The Wiktionary-derived evaluation set

Wiktionary's editors attach every usage example and quotation to the meaning it illustrates. That attachment is the label.

1. `validation/build-wiktionary-set.ts` reads the Kaikki extract of 2026-10-30 and keeps English records whose headword is one lower-case word (letters only) and whose entry, after the pack's own rules (`src/dict/kaikki.ts`: inflection senses become pointers, empty glosses are dropped), keeps at least two meanings in one part of speech: 52,956 entries with an example.
2. An example qualifies when it has at least six words, is not a quotation dated before 1900, and contains the headword or an inflected form (the record's `forms`, or a regular suffix the lookup itself would strip) as a standalone word (not part of a hyphenated word). Where the editors marked the headword in bold (`bold_text_offsets`), that span is used; otherwise the first standalone occurrence. Of 257,189 examples looked at, 167,775 qualified; 66,047 were left out as archaic, 16,586 as short, 6,458 without a usable occurrence.
3. One example per entry is drawn by the smallest seeded SHA-256 (seed `cd-validation-v1`), then up to 450 entries per stratum of meanings in the entry: 2, 3–4, 5–8, 9–16, 17–32, 33+. Only 63 entries in the whole extract fall in 33+, so that stratum has 63.
4. The occurrence becomes the selection, and the context is cut as the content script cuts it: white space collapsed, at most 120 characters on each side. Wiktionary examples are usually one sentence, so most items have less context than a web page gives.
5. The word is looked up in the real pack with the extension's own `WiktionaryDictionary.define`. The labelled entry is the result entry with the same headword, part of speech and the very same list of definitions, and the labelled meaning is the one at the same index. 13 items were excluded because the lookup did not return that entry (for example when the occurrence's form led elsewhere); 2,300 remain: 448, 446, 447, 447, 449 and 63 per stratum; 1,314 nouns, 512 verbs, 370 adjectives, 60 adverbs, 44 others; 1,541 quotations and 759 usage examples.
6. Prompts are built with the extension's own `senseRequest` for every cap evaluated, and scored by the real model inside the built extension (`validation/score-prompts.ts`: an extension page, the built `model-worker.js` and ONNX Runtime files, the time from posting `score` to the answer, as the ranker sees it). Model order is the extension's own `contextualOrder` on the stored logits: a "none of the above" answer, a refused prompt or an answer later than the budget leaves dictionary order, as in the extension. 9,990 distinct prompts were scored.

**No leakage.** The prompt holds the passage and the definitions only: `senseRequest` reads `sense.definition`, never `sense.examples`. The builder checks every prompt anyway: no choice line contains the passage or any example of any offered meaning. No prompt failed.

The committed list `validation/data/wiktionary-items.tsv` holds the identifiers (word, part of speech, meaning index, first 16 hex digits of the example's SHA-256, stratum), not the texts; rerunning the builder on the same extract regenerates it byte for byte.

### The hand-written set

105 sentences in the style of news, documentation, forum posts and recipes (`validation/data/written-raw.tsv`), each with a target word, and the Wiktionary meaning judged correct (`written-labels.tsv`). **They were written and labelled by the agent that ran stage 3 (a model), with no human review**, and the labels were committed (f733a13, in #9) before the model was run on them. One sentence ("Set the environment variable…") has no fitting meaning in the pack and is left out, so 104 items. They favour common words with many meanings (median 12 meanings in the labelled entry), so they are harder for dictionary order than the Wiktionary set.

The pdfpal pilot passages (`~/src/sense-model/data/pilot`) were not used: their labels are WordNet sense identifiers, not Wiktionary meanings, and mapping them would mean labelling them again.

### Limits of the labels

- An example can fit more than one meaning (Wiktionary lists near-synonymous sub-senses, and parent and child glosses), and the label is the one meaning the editors attached it to. Both orders are scored against the same single label, so this lowers both numbers.
- The labels are editors' attachments, not adjudicated word-sense annotations; some are surely wrong.
- Wiktionary's first meaning is not chosen by frequency (it is often the oldest or the most general), so dictionary order is a weak baseline. That is the baseline the card would otherwise show, which is why it is the one compared.
- The examples are Wiktionary's, often literary or quoted, and shorter than web page context; the strata over-represent words with many meanings (weighted back to the extract's entries, the numbers are given too). The checkpoint was trained on WordNet-based data; its base model was pretrained on web text, which may include Wiktionary pages, and this was not checked.
- The hand-written set is small (104 items; its intervals are about ±10 points) and model-written and model-labelled.

## Accuracy

### Model order against dictionary order

At the shipped defaults (at most 24 meanings, 1,600 characters), with no budget (on 8 threads every one of these prompts is answered within 750 ms, so the default budget changes nothing here):

| Set | Items | First, dictionary | First, model | Top 3, dictionary | Top 3, model | Mean rank, dictionary | Mean rank, model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Wiktionary, stratified | 2,300 | 28.2% | **55.4%** | 60.1% | **77.9%** | 4.84 | 3.72 |
| Wiktionary, weighted to the extract's entries | | 43.5% | **71.0%** | 86.9% | **95.3%** | | |
| Hand-written | 104 | 26.9% | **64.4%** | 55.8% | **75.0%** | 6.10 | 4.73 |

Paired bootstrap (2,000 resamples) 95% intervals of model minus dictionary: Wiktionary first +27.2 points (24.8 to 29.7), top three +17.8 (16.0 to 19.5); hand-written first +37.5 (27.9 to 47.1), top three +19.2 (11.5 to 27.9).

"First" is the labelled meaning listed first within its entry; "top 3" within the first three, which is what the card shows before "Show all meanings"; rank is its position within the entry.

By meanings in the labelled entry (Wiktionary set, defaults):

| Meanings in the entry | Items | First, dictionary | First, model | Top 3, dictionary | Top 3, model | Mean rank, dictionary | Mean rank, model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 448 | 54.9% | 78.1% | 100.0% | 100.0% | 1.45 | 1.22 |
| 3–4 | 446 | 41.5% | 72.0% | 91.0% | 98.0% | 2.00 | 1.37 |
| 5–8 | 447 | 23.5% | 58.8% | 58.2% | 87.9% | 3.24 | 1.87 |
| 9–16 | 447 | 13.9% | 43.0% | 37.1% | 67.8% | 5.64 | 3.59 |
| 17–32 | 449 | 10.0% | 30.5% | 21.4% | 43.7% | 9.41 | 8.01 |
| 33+ | 63 | 9.5% | 19.0% | 11.1% | 23.8% | 22.16 | 21.51 |

By part of speech (Wiktionary set, defaults):

| Part of speech | Items | First, dictionary | First, model | Top 3, dictionary | Top 3, model |
| --- | ---: | ---: | ---: | ---: | ---: |
| noun | 1,314 | 28.4% | 54.8% | 59.1% | 76.8% |
| verb | 512 | 25.6% | 56.6% | 54.7% | 76.6% |
| adjective | 370 | 30.8% | 59.2% | 70.0% | 84.3% |
| adverb | 60 | 36.7% | 55.0% | 83.3% | 86.7% |
| other | 44 | 20.5% | 29.5% | 40.9% | 61.4% |

Hand-written set by genre (defaults): news 18.5% → 59.3% first (27 items), forums 42.3% → 69.2% (26), recipes 42.3% → 65.4% (26), documentation 4.0% → 64.0% (25).

### The candidate cap

All without a budget. "Not offered" is the share of items whose labelled meaning was not among the meanings scored (meanings are shared round-robin between the word's entries, so a word with many entries reaches a small cap quickly). "None of the above" is the model choosing it, which leaves dictionary order.

| Prompt | Order applied | None of the above | Refused as too long (over 2,048 tokens) | Labelled meaning not offered | First | Top 3 | Mean rank |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cap 8 | 96.4% | 0.8% | 0.0% | 28.0% | 49.4% | 68.9% | 4.31 |
| cap 12 | 98.9% | 0.4% | 0.0% | 21.4% | 53.2% | 74.3% | 4.02 |
| cap 16 | 99.2% | 0.3% | 0.0% | 15.3% | 55.4% | 78.1% | 3.73 |
| cap 24 | 99.2% | 0.2% | 0.0% | 8.8% | 58.3% | 82.6% | 3.26 |
| cap 48 (old default) | 99.2% | 0.2% | 0.1% | 1.2% | 61.6% | 87.3% | 2.43 |
| no cap (127) | 98.0% | 0.2% | 1.2% | 0.0% | 61.3% | 86.9% | 2.36 |
| cap 48, 1,200 characters | 98.9% | 0.3% | 0.0% | 21.3% | 52.6% | 74.0% | 4.01 |
| cap 48, 1,600 characters | 99.1% | 0.3% | 0.0% | 15.2% | 55.5% | 78.0% | 3.71 |
| **cap 24, 1,600 characters (default)** | 99.1% | 0.3% | 0.0% | 15.3% | 55.4% | 77.9% | 3.72 |

The rest of each row (to 100%) is lookups the extension does not score: 0.5% not English (after the fix below; 4.9% before it), and at cap 8 2.2% where no entry got two meanings. With no budget, more meanings is better: the model rarely errs by being offered too much. The cap is a question of time.

## Latency

### One prompt, by meanings offered (8 threads)

All 9,247 distinct prompts of the Wiktionary set (every cap and variant), from posting `score` to the answer:

| Meanings offered | Prompts | Median tokens | p50 | p90 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1–4 | 753 | 104 | 113 ms | 173 ms | 237 ms | 363 ms |
| 5–8 | 2,100 | 205 | 215 ms | 304 ms | 470 ms | 895 ms |
| 9–16 | 4,510 | 316 | 355 ms | 538 ms | 831 ms | 2,214 ms |
| 17–32 | 1,435 | 508 | 659 ms | 1,163 ms | 2,005 ms | 3,317 ms |
| 33+ | 449 | 1,103 | 2,037 ms | 3,550 ms | 5,454 ms | 5,809 ms |
| All | 9,247 | 303 | 338 ms | 844 ms | 2,944 ms | 5,809 ms |

About 1 ms per token up to 300 tokens, rising to about 2 ms per token at 1,300 (median ms per token by size of prompt: 1.05, 1.03, 1.11, 1.25, 1.45, 1.82, 2.23 for 0–150, 150–250, 250–400, 400–600, 600–900, 900–1,300 and 1,300–2,100 tokens). A meaning costs 20–37 tokens (p10–p90, median 25), so the number of meanings is a poor predictor of time; the prompt's length is a good one. 30 prompts were refused by the worker as over 2,048 tokens, all at cap 48 or no cap.

Per variant, the prompts actually used for the 2,300 items: cap 48: median 254 tokens, p90 958, max 2,085; p50 275 ms, p90 1,636 ms, p99 3,307 ms, max 5,809 ms. **Default (24, 1,600 characters): median 253 tokens, p90 424, max 507; p50 275 ms, p90 518 ms, p99 593 ms, max 688 ms.** 1,200 characters: p50 257 ms, p90 366 ms, p99 419 ms, max 820 ms.

### Fewer threads

512 prompts (those of 300 items, every fifth in id order: cap 48, and 48 with 1,200 and 1,600 characters), scored with 8, 4 and 2 threads (the 4- and 2-thread runs started at load averages of 4.0 and 4.1, from the run before them winding down). Model load (posting `load` to `ready`, including two warm-up prompts): 1.25–1.31 s with 8 threads, 1.33 s with 4, 1.36 s with 2.

| Meanings offered | Prompts | 8 threads p50 / p90 | 4 threads p50 / p90 | 2 threads p50 / p90 |
| --- | ---: | ---: | ---: | ---: |
| 1–4 | 95 | 113 / 155 ms | 123 / 169 ms | 188 / 259 ms |
| 5–8 | 80 | 208 / 350 ms | 230 / 372 ms | 367 / 580 ms |
| 9–16 | 192 | 357 / 486 ms | 408 / 557 ms | 641 / 867 ms |
| 17–32 | 109 | 569 / 1,216 ms | 644 / 1,391 ms | 991 / 2,123 ms |
| 33+ | 36 | 1,720 / 2,927 ms | 2,070 / 3,082 ms | 3,124 / 4,675 ms |
| All | 512 | 350 / 1,071 ms | 398 / 1,240 ms | 620 / 1,891 ms |

4 threads are only 10–20% slower than 8 on this machine; 2 threads about 1.8×.

### The real extension path

`validation/extension-bench.ts`: a production build loaded unpacked, `assets-v1` downloaded once through the extension's own download code into a template profile (dictionary 66.5 MB in 9.8 s, model 147 MB in 19.8 s), each run on a fresh copy of that profile so its first lookup is the first of a browser session. Lookups are sent the way the popup sends them (an extension page → service worker → offscreen document → pack and model worker) and timed in the page. The sample is 400 Wiktionary items (every fifth in id order).

Two runs of each build; "before" is `main` at 6d1fc74 with cap 48 and a 2,000 ms budget (so its times are not cut off), "after" is `main` at c114c48 with the defaults. The second "after" run started at a load average of 7.8 and the first "before" run at 2.7 (the previous run's browser closing); the others below 1.

| | Before | After |
| --- | ---: | ---: |
| First lookup of a session, ordering off | 1,031 / 1,027 ms | 100 / 115 ms |
| Second lookup | 10 / 9 ms | 55 / 70 ms (the background check is running) |
| Lookups with ordering off, p50 / p90 / p99 / max | 7.6 / 9.9 / 12.2 / 20 ms | 7.3–8.4 / 10.1–12.4 / 55–71 / 94–112 ms |
| Model ready after turning ordering on | 5.9 / 5.8 s | 2.6 / 3.0 s |
| Model ready again, files already checked this session | 1.4 s | 1.35 / 1.43 s |
| Lookups while the model loads (dictionary order) | – | 78–219 ms |
| Lookups with ordering on, ordered on the first try | 362 of 400 (budget 2,000 ms) | 399 / 399 of 400 (budget 750 ms) |
| Lookups with ordering on, p50 / p90 / p99 | 245 / 1,402 / 2,026 ms | 253 / 505 / 579 ms; 290 / 535 / 598 ms |
| "mouse" in "Drag the mouse to move the cursor on screen" | 749 ms, ordered; repeat 4 ms | 381–404 ms, ordered; repeat 3–4 ms |

"Lookups with ordering on" includes the dictionary lookup and the messaging; the one lookup in 400 not ordered had no prompt (nothing to reorder).

Before, by meanings offered (cap 48, so the old prompts): 1–4: p50 126 ms; 5–8: 184 ms; 9–16: 353 ms; 17–32: 841 ms (p90 1,429 ms); 33+: 1,711 ms, and only 23 of 48 ordered within 2,000 ms.

A session that starts with ordering on (the default now), lookups sent at once, two runs each: before #12, first lookup 596 / 603 ms, the next seven 75–423 ms, model ready 3.5 s after the first lookup; after #12, 263 / 273 ms, 70–173 ms, 2.8 / 2.9 s.

Ten common words with many meanings in ordinary sentences ("mouse", "bank" twice, "fires", "string", "list", "slice", "fire", "key", "run"), whose prompts reach the length limit: 365–473 ms each in two runs before #12 and 410–617 ms in the two final runs, always ordered; the same with an ordinary page in front of the extension's pages.

Dictionary-only times include the messaging from the page through the service worker; the pack itself answers a lookup in about 0.1–10 ms (`docs/dictionary-build.md`).

### Memory

Resident (RSS) and proportional (PSS) memory of the extension's renderer process, which holds the offscreen document, its model worker, the service worker and the blank page that sends the lookups (`/proc/<pid>/smaps_rollup`):

| State | RSS | PSS |
| --- | ---: | ---: |
| Dictionary open, no model | 249–272 MB | 79–100 MB |
| Model loaded | 1,291–1,301 MB | 1,114–1,122 MB |
| After 400 ordered lookups | 1,040–1,338 MB | 859–1,156 MB |
| After the idle unload (10 minutes without lookups; ranker `idle`) | 276–280 MB | 94–98 MB |

So the model costs about 1 GB while loaded (the earlier estimate of 760 MB, from `measureUserAgentSpecificMemory`, counted JavaScript and WebAssembly heaps only), and the idle unload gives it back.

## Budget coverage and the choice of defaults

Share of ambiguous lookups (those for which a prompt is built) the model answered within the budget, on the Wiktionary set, and the resulting accuracy (lookups that were not answered in time count with dictionary order):

| Prompt | Threads | 250 ms | 350 ms | 500 ms | 750 ms | 1,000 ms | 2,000 ms | First at 750 ms | Top 3 at 750 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cap 8 | 8 | 82% | 97% | 100% | 100% | 100% | 100% | 49.4% | 68.9% |
| cap 12 | 8 | 53% | 80% | 96% | 100% | 100% | 100% | 53.2% | 74.3% |
| cap 16 | 8 | 48% | 60% | 84% | 97% | 99% | 100% | 54.9% | 77.6% |
| cap 24 | 8 | 48% | 57% | 65% | 82% | 93% | 100% | 53.3% | 76.7% |
| cap 48 (old) | 8 | 48% | 57% | 65% | 74% | 80% | 94% | 51.5% | 74.4% |
| 1,200 characters | 8 | 49% | 83% | 100% | 100% | 100% | 100% | 52.6% | 74.0% |
| **1,600 characters (default)** | 8 | 48% | 57% | 85% | **100%** | 100% | 100% | **55.4%** | **77.9%** |

With fewer threads (the 300-item subset):

| Prompt | Threads | 250 ms | 350 ms | 500 ms | 750 ms | 1,000 ms | 2,000 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cap 48 | 8 / 4 / 2 | 51 / 49 / 30% | 59 / 56 / 43% | 69 / 66 / 53% | 75 / 73 / 64% | 81 / 78 / 70% | 95 / 93 / 85% |
| 1,200 characters | 8 / 4 / 2 | 53 / 50 / 30% | 84 / 69 / 43% | 100 / 100 / 56% | 100 / 100 / 100% | 100 | 100 |
| 1,600 characters | 8 / 4 / 2 | 51 / 49 / 30% | 60 / 56 / 43% | 86 / 73 / 53% | 100 / 100 / 67% | 100 / 100 / 98% | 100 |

On the hand-written set, at 750 ms on 8 threads: cap 48 answers 40% in time (first 46.2%); 1,200 characters 100% (54.8%); 1,600 characters 100% (64.4%).

**Decisions** (#11):

1. **A length limit, not only a meaning cap.** The time is set by the prompt's length, and meanings vary from 20 to 37 tokens, so the ranker now limits the prompt to 1,600 characters (about 420 tokens; the offscreen document has no tokenizer, and characters per token are 3.5–4.1). `senseRequest` drops meanings from the end of the round-robin order until the prompt fits, as it already did for the model's own bound.
2. **`budgetMs` 750** (was 350): with the length limit, every lookup of both sets was answered within 750 ms on 8 and 4 threads, against 57% within 350 ms; most lookups take far less (p50 0.27 s), and the card appears as soon as the answer arrives.
3. **`maxCandidates` 24** (was 48): the length limit is reached first in all but 18 of 2,391 prompts; 24 is a guard for words with many very short definitions.
4. 1,200 characters with a 500 ms budget was the other candidate: 100% in time on 8 and 4 threads at 500 ms, 56% on 2 threads, but 2.8 points lower first-meaning accuracy on the Wiktionary set and 9.6 points lower on the hand-written set, whose common words reach the limit. A longer limit (or cap 48) is more accurate still (61.6% first with no limit) but takes 2 s or more for the words with most meanings.
5. **No retry after a token-limit refusal.** Every token is at least one character, so a prompt of at most 1,600 characters can never exceed the worker's 2,048 tokens; at the old cap 48 such refusals were 0.1% of lookups.
6. **Shortening long definitions inside the prompt** (keeping the label and the last gloss level of definitions over 150 characters, cut at 200): measured and not kept. With 1,200 characters it gave +1.0 point first meaning and made 0.4 points fewer lookups fit 350 ms; at cap 16 +0.5 points. Inside the noise, and it would make the model see text the card does not show.
7. **"Order by context" on by default** (was off): model order is clearly better than dictionary order on the Wiktionary set (above). The model still downloads only after the reader confirms its size; until then, the popup says it is needed and cards keep dictionary order. The cost is about 1 GB of memory while the model is loaded, released after ten idle minutes.

## Fixes

- **The first lookup of a session no longer hashes the pack (#10, #12).** `LocalAssetService.open` hashed all of a stored file before returning it; for the 66 MB pack that made the first lookup of each browser session take about a second, and every first model load waited for 267 MB of hashing. Now it checks the size at once and hashes in the background, once per session, 1 MB at a time, one file at a time; a file that fails is removed, its bundle shows as missing, and the offscreen host drops the dictionary or closes the model. Meanwhile a damaged pack can at worst fail a lookup (each block is gzip-checked when read) and a damaged model at worst produce a wrong order until the check removes it. Before and after: first lookup 1,031 → 100–115 ms; model ready after turning ordering on 5.9 → 2.6–3.0 s (8 MB chunks gave 4.6 s and 130–250 ms lookups during the hash; checking all files at once gave 600 ms first lookups at a session start with ordering on).
- **Short English sentences were refused (#11).** `looksEnglish` needed two words from a short list of English function words when a passage had six or more words, and refused 4.9% of the English Wiktionary examples ("The expense far exceeds what I expected."). It now needs one, from a longer list of common words that are not function words of the six European languages it checks, and still twice as many as foreign function words: 0.5% refused, and every foreign-language test passes (Italian, Dutch, Indonesian, Swedish, Spanish and Portuguese sentences added). Real web pages give up to 240 characters of context, so the old rate there was probably lower.

## Acceptance

`validation/acceptance.ts` on the final `main` (c114c48): `npm run package` (`contextual-dictionary-0.1.0.zip`, 3,842,141 bytes, SHA-256 `11f0fec9…d502`), unzipped and loaded unpacked in a fresh Chromium profile, with the real release over the network. Card times are from the start of the double-click to the final card in the page, polled on every animation frame.

- Fresh profile: dictionary and model missing, "Order by context" on (the new default). The dictionary's "Download" in the extension's window installed it in 6.5–6.9 s; the model section said "Needs a one-time download of 147.0 MB" and "Order by context needs the model…", and its "Download" installed it in 13.5–15.4 s; the model was ready 1.3–1.6 s later. Stored: 66,467,698 and 270,540,257 bytes.
- "mouse" in "Drag the mouse to move the cursor on screen." with ordering on: card in 500 ms, first meanings "(computing) An input device…", "(computing, by extension) An input device…", "(figurative) Any mammal of the many rodent families…"; the same lookup again: 67 ms from the cache. Ordering off: 54 ms, "(loosely) Any mammal of the many rodent families…", "(strictly) Any mammal…", "(figurative)…", the dictionary's order.
- "bank" in "She deposited the cheque at the bank…": 461 ms, first meaning "An institution where one can place and borrow money…". "bank" in "The children sat on the grassy bank of the river…": 493 ms, but the first entry is still the financial one (its first meaning became "A branch office of such an institution"): the river bank is a separate entry, the fourth, and **entries keep dictionary order**. See the recommendations.
- Offline (Playwright's network emulation): "bank" in 474 ms with all 8 entries, "mouse" still ordered.
- Browser restarted on the same profile: both files and the settings were still there; first lookup 317 ms (dictionary order, the model loading), second 192 ms; once the model was ready, "mouse" was ordered.
- Public pages, a few double-clicks each:
  - `en.wikipedia.org/wiki/Computer_mouse`: answered HTTP 429 to the headless browser, both times it was tried, so nothing could be looked up there. Not tried further.
  - MDN, `Element: dblclick event`: "fires" 445 ms (fire, noun "The occurrence, often accidental, of fire…", verb, FIRES), "element" 316 ms, "pointing" 445 ms (the compound "pointing device" first), "event" 244 ms.
  - `blog.mozilla.org/en/`: "web" 415 ms. On the first run, "browser" in a post title showed no card: the title is inside a link, and a double-click on a link follows it, as in any browser. Words inside links are skipped by the script since then.
  - `docs.python.org`, "An Informal Introduction to Python" (in place of Wikipedia): "interpreter" 380 ms, "string" 401 ms, "slice" 410 ms, "list" 446 ms. In "within a string literal" the first meaning shown is still "A long, thin and flexible structure made from threads…", and in "Slice indices…" "(colloquial) An amount of anything": the programming meanings are sub-senses deep in long entries, and the model did not put them first.

## Recommendations (not done)

- **Let the model reorder entries, or mark the best entry.** Homographs are separate entries in Wiktionary ("bank" has a financial and a river entry), and the card keeps entries in dictionary order, so the best meaning of a later entry stays below the whole first entry. The ranker already scores meanings across entries; moving the entry holding the best-scored meaning first (or opening on it) would fix the river-bank case. This changes plan decision "entries keep dictionary order", so it is for the coordinator.
- **Raise the length limit on fast machines.** No limit gives 61.6% first against 55.4%. An adaptive limit (measure the warm-up prompts' speed when the model loads and allow more characters when it is fast) would use the budget better on 8-thread machines and protect 2-thread ones.
- **WebGPU** (plan, risk "WebAssembly is too slow"): would remove the length trade-off.
- **Compounds borrowed from the context**: "struck off the coast" listed "strike off" first ("To remove from a list…"); a compound that ends in a preposition followed by a noun phrase is often not the compound. A few such cases showed in the hand-written set.
- **Memory**: about 1 GB while the model is loaded, now that ordering is on by default. A shorter idle unload (for example 3 minutes) would cost a 1.3 s reload; worth measuring with real use.
- **Wiktionary's long joined definitions** ("A thread or cord on which…: A series of items…") make prompts long and cards wordy; a future pack could keep the last gloss level apart for display.
- The Web Store privacy text is in `docs/privacy.md`; Wikipedia may need a browser that is not headless for a future manual check.

## How to rerun

All scripts read local inputs (the Kaikki extract, the pack, the model export; defaults as in `CLAUDE.md`, overridden by `CD_KAIKKI`, `CD_PACK`, `CD_MODEL_DIR`) and write under `~/.cache/contextual-dictionary/validation/` (`CD_VALIDATION_OUT`). None runs in CI.

```bash
npm ci && npm run build
npx tsx validation/build-wiktionary-set.ts            # 40 s; regenerates validation/data/wiktionary-items.tsv (git diff should be empty)
npx tsx validation/build-written-set.ts               # --list prints each sentence's meanings for labelling
npx tsx validation/score-prompts.ts --threads 8       # about 75 minutes for all 9,990 prompts; resumable
npx tsx validation/analyze.ts                         # Wiktionary set tables; --set written for the other
npx tsx validation/score-prompts.ts --threads 4 --only threads-subset.txt   # the subset file is written by hand, see analyze-threads.ts
npx tsx validation/analyze-threads.ts
npx tsx validation/extension-bench.ts --install       # once: downloads assets-v1 (214 MB) into a template profile
npx tsx validation/extension-bench.ts --build dist --label after --cap 24 --budget 750 [--idle] [--start-on]
npm run package && npx tsx validation/acceptance.ts --public   # downloads assets-v1 again into a fresh profile
```

`threads-subset.txt` holds the prompt hashes of variants `48`, `48|c1200` and `48|c1600` of the first 300 items taken every fifth in id order (the snippet that wrote it is the selection in `analyze-threads.ts`).
