# Stage 3 validation

**Which model each part describes.** From "Answers in brief" to "Recommendations (not done)", the numbers are those of `assets-v1`, the model of the extension's releases 0.1.0 to 0.3.1, except the bullet "Since `assets-v2`" and "2026-11-26: `assets-v2`" under "Acceptance". Release 0.4.0 uses `assets-v2`, the model of "Training round 1 (assets-v2)": its numbers are in that section, against `assets-v1` in "In the extension, against the shipped model (`assets-v1`)". The defaults (`budgetMs` 750, 24 meanings, 1,600 characters) were chosen with `assets-v1` and are unchanged.

How fast the extension is in practice, how well the model orders Wiktionary's meanings, what defaults were chosen from those numbers, and what was fixed. Everything here was measured on 2026-11-23 with the real model (`assets-v1`), the real dictionary pack and production builds of the extension in Chromium. The Simple English Wiktionary set was added on 2026-11-25, with the same model, machine and scripts. The scripts are in `validation/`; how to rerun each measurement is at the end.

## Answers in brief

- **Speed.** On the test machine with 8 threads, a definition alone takes about 8 ms (p90 10–12 ms) once the dictionary is open, and the first one of a browser session about 0.1 s (was 1 s). With "Order by context" on, a lookup of a word with several meanings is ordered in about 0.27 s at the median and 0.6 s at worst (p99 0.59 s, maximum 0.69 s on 2,287 prompts), because prompts are now limited to 1,600 characters; the card waits at most 750 ms. Common words with many meanings ("mouse", "bank", "fire", "string") take about 0.4–0.6 s from the double-click to the card. With 2 threads (a stand-in for a small machine) 67% of lookups are answered within 750 ms; the rest show dictionary order first and the ordered list on a repeat. The model is ready 2.6–3.0 s after ordering is turned on in a new session (1.3–1.4 s when its files were already checked), and the extension's process uses about 1 GB more memory while it is loaded.
- **Accuracy.** Yes, the model's order beats Wiktionary's order, clearly. On 2,300 items labelled by Wiktionary's own editors, with the shipped defaults, the labelled meaning is first in its entry 55.4% of the time with model order against 28.2% with dictionary order (paired 95% interval of the difference 24.8 to 29.7 points), and among the first three meanings in its entry 77.9% against 60.1%. On 104 hand-written web-style sentences: 64.4% against 26.9% first. On 4,167 items from a second dictionary, Simple English Wiktionary, whose entries are short: 84.6% against 48.8% first. It is better in every stratum and every part of speech. It is far from perfect: for entries with 17 or more meanings, the labelled meaning is first in under a third of cases.
- **Defaults.** "Order by context" is now on by default (the model still downloads only after the reader confirms it), `budgetMs` 750, `maxCandidates` 24, and a new prompt length limit of 1,600 characters.

- **Since `assets-v2`** (training round 1, below): the model is fine-tuned from Ettin-150m-WSD on English Wiktionary's own examples. In the extension at the shipped defaults it puts the labelled meaning first 64.3% of the time on the Wiktionary set (55.4% before; paired 95% interval of the difference +7.3 to +10.6 points), 69.2% on the hand-written set (64.4%; +0.0 to +9.6) and 88.0% on the Simple English Wiktionary set (84.6%; +2.5 to +4.3). It answers within the 750 ms budget as often on 8 and 2 threads and in two of three runs on 4 threads (94% in the third), uses about 110 MB less memory while loaded, and downloads 188.8 MB instead of 147.0 MB. Development data chose another run (labels only) as best; this one was chosen after the test results were known, so its test numbers are not an unbiased estimate (see "Which run ships").

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

### The Simple English Wiktionary set

A second dictionary whose editors attach each example to the meaning it illustrates. Simple English Wiktionary is a separate wiki: its definitions are its own, written as plain sentences ("If you run a place, you manage it."), and its examples are short invented sentences, not quotations. The set measures the model on definitions it was not chosen on, and it stays a fair test if a later model is trained on English Wiktionary's examples.

1. `validation/build-simple-set.ts` reads the Kaikki extract of Simple English Wiktionary as served on 2026-10-30 (62,247 lines) and keeps entries by the English set's rules: one lower-case word, and at least two meanings in one part of speech after the pack's rules. 6,845 entries.
2. An example qualifies as in the English set: at least six words, with the word or an inflected form standing alone. This extract marks no bold span and gives no quotation dates, so the first standalone occurrence is used and nothing is left out as archaic. Of 13,484 examples looked at, 12,323 qualified; 948 were short, 105 had no usable occurrence, 108 no text.
3. An example that English Wiktionary also has for the same headword is left out: the same text without case and punctuation, or one inside the other when the shorter has four words or more. 648 of the 12,323 were left out, which left 234 entries with no example and 4,171 with one.
4. One example per entry is drawn by the same seeded hash. Every entry is an item; there is no cap per stratum, because Simple English Wiktionary has few long entries. 4 entries were excluded because the labelled definition appears twice in the entry. 4,167 items remain: 2,596, 1,283, 262, 25, 0 and 1 per stratum; 2,237 nouns, 1,047 verbs, 646 adjectives, 115 adverbs, 122 others; 3,731 different headwords.
5. There is no pack of Simple English Wiktionary. The meanings offered are every entry of the headword's spelling, in extract order, under the pack's rules (`simpleResult` in `validation/simple-items.ts`): proper names left out, empty glosses dropped, markup removed. 1,973 items offer more than one entry (the noun and the verb, for example). The lookup's inflection and compound steps do not run: in 923 items the selection is an inflected form and the meanings offered are still its headword's.
6. Prompts are built and scored as for the English set: 4,566 distinct prompts, scored in 8 minutes. The same leakage check found nothing.

`validation/data/simple-items.tsv` holds the identifiers, as for the English set.

How this set differs from the English one:

- The passages are shorter: 10 words (55 characters) at the median, against 21 words (121 characters).
- The entries are shorter: 62% of the items are in entries with two meanings, where dictionary order is right about half the time. Its totals cannot be compared with the English set's; compare stratum with stratum.
- It is not fully apart from English Wiktionary. The two wikis share editors, nearly all of its headwords are English Wiktionary headwords too, and 54 items' labelled definition is word for word one of English Wiktionary's definitions of that word (marked `definitionInEnglish` in the items).

### Held out of training

No model measured here was trained on Wiktionary: the model card of `sign/Ettin-150m-WSD`, read on 2026-11-25, names only WordNet-based training data (SemCor, WordNet's own examples, the Princeton WordNet Gloss Corpus, generated sentences for WordNet synsets) and unlabelled Wikipedia sentences for distillation.

If a model is trained on English Wiktionary's examples, these sets stay tests only under this rule: **no example of a headword of the English set or of the hand-written set goes into training**, in any part of speech. Those are the 2,146 words of the first column of `wiktionary-items.tsv` and the lemmas of `written-labels.tsv`, 2,197 in all. The split is by headword, not by example, because the examples of one entry share its definitions.

The Simple English Wiktionary set is not held out by headword: that would take 3,731 common words out of training. Its definitions and examples are never training data, and 953 of its items are on held-out headwords; `analyze.ts --set simple` reports those apart.

### Limits of the labels

- An example can fit more than one meaning (Wiktionary lists near-synonymous sub-senses, and parent and child glosses), and the label is the one meaning the editors attached it to. Both orders are scored against the same single label, so this lowers both numbers.
- The labels are editors' attachments, not adjudicated word-sense annotations; some are surely wrong.
- Wiktionary's first meaning is not chosen by frequency (it is often the oldest or the most general), so dictionary order is a weak baseline. That is the baseline the card would otherwise show, which is why it is the one compared.
- The examples are Wiktionary's, often literary or quoted, and shorter than web page context; the strata over-represent words with many meanings (weighted back to the extract's entries, the numbers are given too). The checkpoint was trained on WordNet-based data; its base model was pretrained on web text, which may include Wiktionary pages, and this was not checked.
- The hand-written set is small (104 items; its intervals are about ±10 points) and model-written and model-labelled.
- The Simple English Wiktionary set is easy: short entries, and learner sentences written to show one meaning plainly. It says little about words with many meanings (26 items in entries of nine or more), which is where the model is weakest.

## Accuracy

### Model order against dictionary order

At the shipped defaults (at most 24 meanings, 1,600 characters), with no budget (on 8 threads every one of these prompts is answered within 750 ms, so the default budget changes nothing here):

| Set | Items | First, dictionary | First, model | Top 3, dictionary | Top 3, model | Mean rank, dictionary | Mean rank, model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Wiktionary, stratified | 2,300 | 28.2% | **55.4%** | 60.1% | **77.9%** | 4.84 | 3.72 |
| Wiktionary, weighted to the extract's entries | | 43.5% | **71.0%** | 86.9% | **95.3%** | | |
| Hand-written | 104 | 26.9% | **64.4%** | 55.8% | **75.0%** | 6.10 | 4.73 |
| Simple English Wiktionary | 4,167 | 48.8% | **84.6%** | 96.1% | **99.7%** | 1.71 | 1.18 |

Paired bootstrap (2,000 resamples) 95% intervals of model minus dictionary: Wiktionary first +27.2 points (24.8 to 29.7), top three +17.8 (16.0 to 19.5); hand-written first +37.5 (27.9 to 47.1), top three +19.2 (11.5 to 27.9); Simple English Wiktionary first +35.8 (34.0 to 37.6), top three +3.6 (3.0 to 4.2).

"First" is the labelled meaning listed first within its entry; "top 3" within the first three meanings in its entry; rank is its position within the entry.

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

Simple English Wiktionary set, by meanings in the labelled entry (defaults):

| Meanings in the entry | Items | First, dictionary | First, model | Top 3, dictionary | Top 3, model | Mean rank, dictionary | Mean rank, model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 2,596 | 55.2% | 87.6% | 100.0% | 100.0% | 1.45 | 1.12 |
| 3–4 | 1,283 | 41.0% | 80.8% | 95.2% | 99.7% | 1.94 | 1.24 |
| 5–8 | 262 | 26.0% | 74.0% | 66.4% | 96.2% | 2.89 | 1.40 |
| 9–16 | 25 | 28.0% | 84.0% | 48.0% | 100.0% | 4.20 | 1.24 |
| 33+ | 1 | 0.0% | 0.0% | 0.0% | 100.0% | 13.00 | 2.00 |

Dictionary order scores the same as in the English set's strata of the same size (55.2% and 54.9% for two meanings, 41.0% and 41.5% for three or four), and the model scores higher here: 87.6% against 78.1%, 80.8% against 72.0%, and 74.0% against 58.8% for five to eight. Why was not measured; the plain definitions and the invented examples are the likely reasons. By part of speech: nouns 50.9% → 86.2% first, verbs 47.1% → 87.2%, adjectives 46.1% → 81.9%, adverbs 42.6% → 70.4%, others 45.9% → 60.7%. On the 953 items whose headword is held out of training: 45.9% → 84.8%; on the other 3,214: 49.7% → 84.5%. The model answered "none of the above" for 1.0% of the items, and 10 items were not sent to it (6 passages judged not English, 4 with unsafe text). The candidate cap makes no difference in this set (84.2% first at 8 meanings, 84.6% from 12 up).

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

### 2026-11-26: `assets-v2`

The release `assets-v2` was published on 2026-11-26 with `scripts/publish-assets.mjs` (which verified every upload and downloaded the files back anonymously). Checked again from this branch:

- Every file of `assets-v2` downloaded anonymously with `curl` equals its pin in `src/assets/manifest.ts` (transfer size and SHA-256; the graph unpacks to the stored pin), and the two notices equal the files in `notices/`.
- `CD_TEST_REAL_ASSETS=1 npx vitest run test/unit/assets/real-assets.test.ts`: the whole release through the extension's own download code, the dictionary (66.5 MB) in 5.9 s and the model (188.8 MB) in 16.6 s; both bundles ready and verified.
- `npm run package` (`contextual-dictionary-0.3.1.zip`, 3,849,004 bytes, SHA-256 `86fb5e6837c8b1de34a2a9b231c5dd2d13ff79a1c05187aacbeb5daf762360b1`; the version is unchanged) and `npx tsx validation/acceptance.ts --zip package/contextual-dictionary-0.3.1.zip --public`, starting at a load average of 0.30:
  - Fresh profile: the model section said "A word-sense model fine-tuned on English Wiktionary, for “Order by context”. It runs on this computer." and "Needs a one-time download of 188.8 MB."; the dictionary installed in 6.2 s, the model in 17.5 s, and the model was ready 1.55 s later. Stored: 66,467,698 and 207,103,478 bytes.
  - "mouse" in "Drag the mouse to move the cursor on screen." with ordering on: card in 460 ms, first meanings "(computing) An input device…", "(computing, by extension) An input device…", "(figurative, obsolete) Any mammal…"; again: 72 ms. Ordering off: 58 ms, dictionary order.
  - "bank" in both sentences: 412 and 426 ms; the first entry is still the financial one in both (entries keep dictionary order).
  - Offline: "bank" in 440 ms with 3 entries, "mouse" still ordered. After a browser restart on the same profile: files and settings kept, first lookup 280 ms, second 161 ms, "mouse" ordered once the model was ready.
  - Public pages: `en.wikipedia.org` answered HTTP 429 again; MDN ("fires" 438 ms, "element" 317, "pointing" 462, "event" 246), `blog.mozilla.org` ("web" 399 ms) and `docs.python.org` ("interpreter" 372 ms, "string" 417, "slice" 378, "list" 429).

## Recommendations (not done)

- **Let the model reorder entries, or mark the best entry.** Homographs are separate entries in Wiktionary ("bank" has a financial and a river entry), and the card keeps entries in dictionary order, so the best meaning of a later entry stays below the whole first entry. The ranker already scores meanings across entries; moving the entry holding the best-scored meaning first (or opening on it) would fix the river-bank case. This changes plan decision "entries keep dictionary order", so it is for the coordinator.
- **Raise the length limit on fast machines.** No limit gives 61.6% first against 55.4%. An adaptive limit (measure the warm-up prompts' speed when the model loads and allow more characters when it is fast) would use the budget better on 8-thread machines and protect 2-thread ones.
- **WebGPU** (plan, risk "WebAssembly is too slow"): would remove the length trade-off.
- **Compounds borrowed from the context**: "struck off the coast" listed "strike off" first ("To remove from a list…"); a compound that ends in a preposition followed by a noun phrase is often not the compound. A few such cases showed in the hand-written set.
- **Memory**: about 1 GB while the model is loaded, now that ordering is on by default. A shorter idle unload (for example 3 minutes) would cost a 1.3 s reload; worth measuring with real use.
- **Wiktionary's long joined definitions** ("A thread or cord on which…: A series of items…") make prompts long and cards wordy; a future pack could keep the last gloss level apart for display.
- The Web Store privacy text is in `docs/privacy.md`; Wikipedia may need a browser that is not headless for a future manual check.

## Training round 1 (assets-v2)

On 2026-11-25 and 26 the small model was fine-tuned on English Wiktionary's own examples, with the larger model of its family as a teacher, and the result replaced the checkpoint in the release `assets-v2` (`docs/assets.md`). Same machine as above, with an NVIDIA GeForce RTX 3060 (12 GB) for training and scoring in PyTorch. The scripts are `validation/build-train-set.ts`, `validation/build-unlabelled-set.ts` and `validation/training/` (`README.md` there); everything they write is under `~/.cache/contextual-dictionary/validation/train/` and holds Wiktionary or Wikipedia text, so none of it is committed.

### Data

**Labelled examples.** `build-train-set.ts` reads the same Kaikki extract as the evaluation builders and applies their rules (one lower-case word, at least two meanings in one part of speech after the pack's rules, `judgeExample`, the context cut of `selectionAt`, the lookup in the real pack, `senseRequest` through `variantRequest`), but keeps every usable example, at most 12 per entry (seeded), in two prompt forms: the shipped defaults (`24|c1600`) and no cap (`127`). The rule of "Held out of training" above is applied: the 2,197 headwords of `wiktionary-items.tsv` and `written-labels.tsv` are skipped (3,754 entries), and an item is also dropped when the lookup returns an entry of a held-out lemma (2,274). The other headwords are split by `sha256("cd-train-r1\n" + headword)`: the first 4% of the hash space is the development side (`validation/training-items.ts`).

| | Items | Headwords | 2 meanings | 3–4 | 5–8 | 9–16 | 17–32 | 33+ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Training | 125,031 | 34,993 | 48,394 | 41,108 | 25,404 | 9,846 | 279 | 0 |
| Development | 4,951 | 1,378 | 1,863 | 1,756 | 952 | 380 | 0 | 0 |

Training items: 69,789 nouns, 24,365 verbs, 25,837 adjectives, 3,462 adverbs, 1,578 others; 96,528 quotations and 28,503 usage examples. **The held-out headwords take nearly all entries with many meanings**: 464 entries with 17–32 meanings and all 63 with 33+ are held out, so 45 such entries (279 items) remain for training and none for development. Training cannot learn much about long entries, and development cannot see them.

Each prompt became a sense-model example (`validation/training/prepare_examples.py`), and sense-model's own `format_prompt` had to rebuild the extension's prompt byte for byte; every one did. The no-cap form differs from the defaults for 5.6% of the items (most entries are short). Where the cap leaves the labelled meaning out of the prompt (1,667 training items), the prompt is not turned into a "none of the above" label (sense-model's `gold_ids: []` means that no offered meaning fits, which is not true there); it is used with the teacher's answers only.

**Leak checks** (`validation/training/check_leaks.py`, built into `build-train-set.ts`): no training or development headword, and no lemma the unlabelled stream looked up, is held out; training and development headwords are disjoint. The headword rule did not catch everything: the same quotation is often filed under several headwords, and 46 training passages and 2 development passages were equal to a Wiktionary test passage after normalisation (case folded, punctuation dropped); 557 more shared a run of ten words with a test passage. All 605 were dropped, and the same check on the final files found no equal passage and no shared run of ten words with any of the three test sets. 4 identifiers that appeared twice (the same example under the same meaning) are kept once. Final training examples: 129,093 labelled, 1,658 teacher-only. The table above counts the items before this check: of the 4,951 development items, the 20 it dropped (2 equal to a test passage, 18 sharing a run of ten words with one) leave the 4,931 of the development results below, and the 125,031 training items become 124,442 (585 dropped, 4 repeated).

**Unlabelled stream** (teacher only). One shard of English Wikipedia as published at `https://huggingface.co/datasets/wikimedia/wikipedia`, revision `b04c8d1ceb2f5cd4588862100d08de323dccfbaa`, file `20231101.en/train-00001-of-00041.parquet` (351 MB, SHA-256 `6cd57a5825312ca966313d4a1b614690b5c4fb53cee9b124bc0e999977eb36cf`, CC BY-SA 3.0 and GFDL as the dataset states), downloaded on 2026-11-25. `validation/training/wiki_paragraphs.py` took a seeded sample of 60,000 prose paragraphs of 120–700 characters; `build-unlabelled-set.ts` picked one lower-case word per paragraph whose lookup gives a prompt and whose looked-up lemmas are neither held out nor on the development side, at most 15 per lemma: 47,910 items, 55,138 examples.

### Training

The trainer (`validation/training/train_thin.py`) uses sense-model's own dataset, loss and trainer class (`wsd.train`) and its model class, with three differences from `wsd train`: candidates keep the extension's order (sense-model shuffles them), batches are grouped by length, and two defects found on the way are worked around in the script: under transformers 5 the loss and gradients came out multiplied by the number of accumulation steps (the model's `forward` takes `**kwargs`, so the trainer assumes the loss is already normalised), and a run resumed after a crash drew a new batch order (the length-grouped sampler shuffles from global random state; the script seeds it by epoch). Both belong fixed in sense-model.

A pilot run on 2026-11-25 (labels and teacher, 39,999 of the labelled training examples, one epoch of 625 steps of 64, about 2 seconds a step) tried the trainer, the teacher cache, the resume and the export before the three runs; the trainer's development score (labelled meaning first on 2,000 development prompts whose labelled meaning is offered) went from 69.5% to 74.8%. It showed the second defect: its first attempt, resumed from step 300, trained on a new batch order (training loss 0.772 against 0.834 at step 310 over the same steps), while the second attempt, with the sampler seeded by epoch, took 23 minutes with an interruption and a resume, and resumed onto the same batches (0.8531 against 0.8534). The workaround for the first defect was already in the script the pilot ran, so the kept logs do not show that one.

Recipe, as the upstream card describes its own: loss 0.3 × label cross-entropy (label smoothing 0.1) + 0.7 × T² × KL to the teacher at T = 2; learning rate 5e-5, cosine schedule, batch 64 (4 × 16 accumulation), seed 42, at most 3 epochs; evaluation every 300 steps on 2,000 development prompts of each form, the best checkpoint by "labelled meaning first" at the defaults, early stopping after 4 evaluations without improvement. The rest, from `train_thin.py`, its arguments (`args.json` of each run) and the logged learning rate: AdamW as the trainer's default (PyTorch's fused AdamW, betas 0.9 and 0.999, ε 10⁻⁸), weight decay 0.01, gradients clipped to norm 1; a linear warm-up over the first 10% of the planned steps (606 for labels only, 872 for the other two) and then the cosine decay towards zero at the planned end, which early stopping never reached; bf16 mixed precision; batches grouped by length (transformers' length-grouped sampler, seeded by epoch), prompts of at most 2,048 tokens (no training prompt was longer); the 2,000 development prompts of each form drawn with seed 42 from those whose labelled meaning is offered. Teacher scores were computed in batches of at most 8,192 tokens. Teacher: `sign/Ettin-1B-WSD` revision `e6fc37a7e11fee91a600a0cd8e7423bcc639a1cc`, soft labels computed in bf16 (agreeing with fp32 on 99.4% of top choices, development accuracy identical; batched scores equal to one-at-a-time scores). Every accuracy below is fp32.

| Run | Data | Stopped at | Chosen checkpoint |
| --- | --- | ---: | ---: |
| Labels only | 129,093 labelled | step 4,200 of 6,054 | 3,000 |
| Teacher only | the labelled prompts without their labels, the teacher-only ones and the unlabelled stream (185,889) | step 4,200 of 8,715 | 3,000 |
| Labels and teacher | the same 185,889, labels where there are | step 4,200 of 8,715 | 3,000 (1.03 epochs) |

Development, all 4,931 items, labelled meaning first / top three at the defaults (and with no cap):

| Model | First | Top 3 | First, no cap |
| --- | ---: | ---: | ---: |
| Dictionary order | 38.1% | 84.3% | 38.1% |
| Untrained (float) | 72.1% | 96.6% | 72.8% |
| Teacher (Ettin-1B-WSD, float) | 79.3% | 97.3% | 80.1% |
| Labels only | **78.6%** | 97.5% | 79.5% |
| Teacher only | 76.7% | 97.3% | 77.7% |
| Labels and teacher | 78.0% | 97.5% | 79.0% |

Test sets, scored once per finished run, float PyTorch, labelled meaning first (paired bootstrap 95% interval of the difference from the untrained float model, 2,000 resamples, seed 1):

| Set, form | Untrained | Labels only | Teacher only | Labels and teacher |
| --- | ---: | ---: | ---: | ---: |
| Wiktionary, defaults | 59.0% | 66.1% (+5.5 to +8.6) | 62.7% (+2.4 to +5.1) | 64.2% (+3.8 to +6.7) |
| Wiktionary, no cap | 66.0% | 75.1% (+7.3 to +10.9) | 71.3% (+3.9 to +6.8) | 73.3% (+5.8 to +8.9) |
| Hand-written, defaults | 65.4% | 69.2% (−1.9 to +9.6) | 67.3% (−2.9 to +6.7) | 70.2% (+0.0 to +9.6) |
| Hand-written, no cap | 75.0% | 80.8% (−1.0 to +12.5) | 79.8% (−1.0 to +10.6) | 83.7% (+3.8 to +14.4) |
| Simple English, defaults | 86.6% | 87.0% (−0.4 to +1.3) | 87.6% (+0.3 to +1.8) | 88.5% (+1.1 to +2.7) |

### Which run ships

Development chose labels only (78.6% against 78.0%), and the export step of the round exported that one. The owner chose labels and teacher after the test results above were known. Against labels only, it is better on the hand-written and Simple English sets and one point worse on the Wiktionary set, and it still answers "none of the above" (labels only did on no test item). Because that choice looked at the test sets, the test numbers of the run that ships (`assets-v2`) are not an unbiased estimate of its accuracy; the difference between the two runs is within the noise of the hand-written set.

### Export

The same recipe as the quantization study of 2026-11-25, with the outlier layers measured again for this model (`validation/training/act_stats_model.py`, 200 development prompts): the input of the feed-forward output (`mlp.Wo`) peaks at 42.9 (layer 4), 1,089 (7), 24.8 (9), 1,663 (11) and 740 (15) times its 99.9th percentile; the next are 13.5 (12) and 13.1 (14), under the cut-off of 15. The ONNX export is sense-model's own (float parity with PyTorch: maximum logit error 4.3 × 10⁻⁶); then `quantize_dynamic` with INT8 weights per channel for the MatMuls except those five, and the token embedding stored in float16 with a cast to float (`validation/training/export_quant.py`). Graph: 203,516,610 bytes; 185,262,587 as the release compresses it (gzip level 9; `assets-v1`: 266,954,889 and 143,435,614). INT8 against float on 1,000 development prompts: the same top choice for 96.6%.

### Where the weights and the raw results are

The GitHub release `assets-v2` holds the INT8 graph only. The float weights it was exported from are `checkpoints/s2-labels-teacher/final/model.safetensors` under `~/.cache/contextual-dictionary/validation/train/` on the maintainer's machine (598,827,368 bytes, SHA-256 `49bc2634…5be3`, the model revision of `src/model/session.ts`). A copy of them, with the INT8 graph and a model card, is in the Hugging Face repository `andrepaim/Ettin-150m-WSD-wiktionary`, which was private when this was written. The rest of the round stays on that machine too: the items, prompts, examples and teacher caches hold Wiktionary or Wikipedia text; the score files hold only prompt hashes and numbers, of no use without the prompts; the checkpoints are 16 GB; and the training curves (`metrics.jsonl`, the TensorBoard events) hold numbers only and are small, and the numbers used here are quoted. `validation/training/README.md` lists every file and every step.

### In the extension, against the shipped model (`assets-v1`)

In this section "the shipped model" and "shipped" mean `assets-v1`, the model the extension shipped when it was written, and "the new model" `assets-v2`.

`validation/score-prompts.ts` with the export, 8 threads, the `24|c1600` prompts of the three sets, the shipped model's answers being those of the measurements above (`scores-8.jsonl`, reproduced exactly by a rerun on 2026-11-25):

| Set | First, `assets-v1` | First, `assets-v2` | Paired 95% interval of the difference | Top 3, `assets-v1` / `assets-v2` | First at 750 ms, `assets-v2` | "None of the above", `assets-v1` / `assets-v2` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wiktionary | 55.4% | **64.3%** | +7.3 to +10.6 | 77.9% / 81.2% | 64.2% | 7 / 22 of 2,287 |
| Hand-written | 64.4% | **69.2%** | +0.0 to +9.6 | 75.0% / 76.0% | 68.3% | 6 / 8 of 104 |
| Simple English | 84.6% | **88.0%** | +2.5 to +4.3 | 99.7% / 99.6% | 88.0% | 42 / 18 of 4,157 |

By meanings in the entry (Wiktionary set, defaults), first: 85.0% (2), 78.9% (3–4), 73.2% (5–8), 53.7% (9–16), 37.0% (17–32), 22.2% (33+), against 78.1, 72.0, 58.8, 43.0, 30.5 and 19.0 for `assets-v1`. Weighted to the extract's entries: 79.2% first (71.0%).

**Latency, 8 threads.** 600 prompts (the 300 slowest of an earlier run and 300 others, seeded), each export twice back to back, the second time in reverse order, each run starting at a load average of 1.3–1.5: the untrained export with the same recipe p50 412 / p99 640 / max 846 ms (1 of 1,200 over 750 ms), labels only 406 / 557 / 619 (0), labels and teacher 421 / 633 / 731 (0); by prompt, the labels-and-teacher export takes 0.93–1.12 times as long as the untrained export (10th to 90th percentile, median 1.03). The run over all 6,548 prompts had 17 over 750 ms (maximum 1,268 ms), 13 of them in one stretch of the run, none of which was slow again in the reruns: activity outside the measurement, which cannot be seen from WSL.

**Fewer threads** (the method of "Fewer threads" above: the same 512 prompts of 300 items and their 24|c1600 prompts, both models back to back at each thread count, each run starting at a load average of 0.9–1.5 with the other processes on the machine idle):

| Threads | Within 750 ms, `assets-v1` / `assets-v2` | Within 500 ms | First at 750 ms, `assets-v1` / `assets-v2` | Top 3 at 750 ms | p50 / p90, all 512 prompts |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 | 100% / 100% | 76% / 83% | 58.0% / 67.3% | 80.7% / 82.7% | 380 / 1,158 ms; 358 / 1,081 ms |
| 4 (three runs) | 100, 100, 100% / 94, 100, 100% | 73–85% / 67–78% | 58.0% / 65.0, 67.3, 67.3% | 80.7% / 80.7–82.7% | 352–394 / 1,109–1,251 ms; 374–429 / 1,131–1,337 ms |
| 2 | 72% / 71% | 54% / 55% | 51.3% / 57.3% | 73.0% / 73.0% | 586 / 1,812 ms; 610 / 1,801 ms |

At 4 threads the new model is 5–10% slower at the median; one run of three answered 94% within 750 ms, against 100% in the other two and for the old model (the first run of each model was its slowest). These 4 and 2 threads run on this machine's performance cores, so a small machine is slower for both models.

**Memory** (`validation/extension-bench.ts` on a measurement copy of the production build whose downloads come from a local server holding the staged releases; nothing else differs; two runs each, the defaults):

| State | `assets-v1` RSS / PSS | `assets-v2` RSS / PSS |
| --- | ---: | ---: |
| Dictionary open, no model | 248–249 / 79–80 MB | 250–252 / 80–81 MB |
| Model loaded | 1,294–1,302 / 1,118–1,126 MB | 1,183–1,188 / 1,007–1,009 MB |
| After 400 ordered lookups | 1,036–1,042 / 855–862 MB | 994–999 / 813–816 MB |
| After the idle unload | 278 / 97 MB | 277 / 96 MB |

In the same runs: model ready 2.40–2.56 s after turning ordering on (2.42–2.56 s), lookups with ordering on p50 / p99 235–242 / 505–517 ms (264–277 / 555–665 ms), 399 of 400 ordered (397), "mouse" ordered in 387–388 ms (379–389 ms).

**What changes from item to item.** "Labelled meaning first" for each test item at the defaults, the shipped model's answers against the new model's (both in the extension):

| Set | Items | Both right | Shipped right, new wrong | Shipped wrong, new right | Both wrong | Shipped-correct items lost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wiktionary | 2,300 | 1,175 (51.1%) | 100 (4.3%): 3 "none of the above", 97 another meaning | 305 (13.3%) | 720 (31.3%) | 100 of 1,275, 7.8% |
| Hand-written | 104 | 66 (63.5%) | 1 (1.0%): another meaning | 6 (5.8%) | 31 (29.8%) | 1 of 67, 1.5% |
| Simple English | 4,167 | 3,399 (81.6%) | 126 (3.0%): 3 "none of the above", 123 another meaning | 266 (6.4%) | 376 (9.0%) | 126 of 3,525, 3.6% |

Hand-written set by genre (both right / shipped right, new wrong / shipped wrong, new right / both wrong): news 15 / 1 / 1 / 10, documentation 16 / 0 / 0 / 9, forums 18 / 0 / 2 / 6, recipes 17 / 0 / 3 / 6.

**What a reader sees.** The site's and the store's captures were looked up again in the extension with both models (the same pages and double-clicks as `validation/site-assets.ts` and `validation/store-assets.ts`; the shipped model's answers matched `site/_examples.json` for all eight examples). The first meaning stays for "moment" (Hamlet), both "conductor" sentences, "bug", "bank", "mouse" and "crane", most with other second and third meanings. It changes for:

- "want" in the Austen example: from "To lack and be in need of…" to the dictionary's first meaning, "To wish for or desire…": a loss.
- "proposition" in the Lincoln example: from the assertion that can be true or false to "A statement of religious doctrine…": a loss.
- "culture" in "Researchers grew the culture in a dish for two weeks before adding the antibiotic.": from "The process of growing…" to "A group of bacteria.": arguably a gain, since what grows in the dish is the organisms ("The growth thus produced." or "A group of bacteria.").
- "cell" in "Each cell in the spreadsheet holds a formula that adds up the row above it." (the store's demonstration page): the right meaning is the twentieth of the first entry (the unit of a statistical array where a row and a column meet); the shipped model opened on the general "A section or compartment of a larger structure.", the new model answers "none of the above" and the card keeps dictionary order: worse.
- "pitch" in "The founders had ten minutes to give their pitch to a room of tired investors.": the right meaning ("An effort to sell or promote something.") is in the fourth of seven entries, and entries keep dictionary order, so both cards open on the first entry's tree sap: wrong under both; only the status line differs ("none of the above" for the new model).

So two clear losses among about twelve captures the shipped model got right. At the Wiktionary set's rate of loss among shipped-correct items (7.8%) twelve such items lose two or more with probability about 0.24 and three or more 0.06; at the hand-written set's rate (1.5%) two or more would have probability about 0.01. The captures were chosen because the shipped model got them right, which makes losses more likely than for an average correct item. Ordinary churn at the Wiktionary rate, unusual at the hand-written rate.

### Limits

- The development set has no entry with more than 16 meanings, and training has 279 items with 17–32 and none with more: what was learnt about long entries comes from the teacher and from short entries.
- The run that ships was chosen after the test results were known (above).
- The hand-written set is small and was written and labelled by a model.
- One machine; the latency on 4 and 2 threads is that of fast cores.
- The Wikipedia shard is one of 41, and the unlabelled stream avoids the held-out headwords, which are many of the commonest words.

## How to rerun

All scripts read local inputs (the Kaikki extracts, the pack, the model export; defaults as in `CLAUDE.md`, overridden by `CD_KAIKKI`, `CD_KAIKKI_SIMPLE`, `CD_PACK`, `CD_MODEL_DIR`) and write under `~/.cache/contextual-dictionary/validation/` (`CD_VALIDATION_OUT`). None runs in CI.

```bash
npm ci && npm run build
npx tsx validation/build-wiktionary-set.ts            # 40 s; regenerates validation/data/wiktionary-items.tsv (git diff should be empty)
npx tsx validation/build-written-set.ts               # --list prints each sentence's meanings for labelling
npx tsx validation/build-simple-set.ts                # 30 s; reads CD_KAIKKI_SIMPLE too; regenerates validation/data/simple-items.tsv (git diff should be empty)
npx tsx validation/score-prompts.ts --threads 8       # about 75 minutes for the first 9,990 prompts, 8 more for the Simple English set's 4,566; resumable
npx tsx validation/analyze.ts                         # Wiktionary set tables; --set written or --set simple for the others
npx tsx validation/score-prompts.ts --threads 4 --only threads-subset.txt   # the subset file is written by hand, see analyze-threads.ts
npx tsx validation/analyze-threads.ts
npx tsx validation/extension-bench.ts --install       # once: downloads the release the build pins (now assets-v2, 255 MB) into a template profile
npx tsx validation/extension-bench.ts --build dist --label after --cap 24 --budget 750 [--idle] [--start-on]
npm run package && npx tsx validation/acceptance.ts --public   # downloads that release again into a fresh profile
```

Training round 1: every step, with its command, inputs, outputs and time, is in `validation/training/README.md`, "Steps". It needs a CUDA GPU, the Python environment of `validation/training/requirements.txt`, the sense-model checkout at `~/src/sense-model` (the scripts import it from there), the evaluation sets above, and the scripts copied into `~/.cache/contextual-dictionary/validation/train/scripts/`, from where they run. In outline (`T` that folder, `PY=../teacher/venv/bin/python`, commands with `scripts/` run from `T`):

```bash
npx tsx validation/build-train-set.ts                                   # labelled training and development items (CD_TRAIN_OUT, default T/data)
$PY -I scripts/wiki_paragraphs.py wiki/train-00001-of-00041.parquet data/wiki-paragraphs.jsonl --n 60000
npx tsx validation/build-unlabelled-set.ts --input ~/.cache/contextual-dictionary/validation/train/data/wiki-paragraphs.jsonl
$PY -I scripts/prepare_examples.py --items data/train-items.jsonl --prompts data/train-prompts.jsonl --out data/train-labelled.clean.jsonl --unlabelled-out data/train-notoffered.clean.jsonl
                                                                        # and four more (README steps 5 to 7)
python3 -I scripts/check_leaks.py                                       # leak report; the list of passages to drop comes out empty
setsid nohup scripts/stage2.sh > logs/stage2.nohup 2>&1 < /dev/null &   # teacher scores, the three runs, development and test scoring, export of the best run on development (README steps 8 to 12 list what it needs)
python3 -I validation/training/release_model_dir.py --export <export> --weights <model.safetensors> --shipped ~/src/sense-model/artifacts/upstream-english --out <dir>
node scripts/publish-assets.mjs --dry-run --model-dir=<dir>             # stages assets-v2 and prints its pins
```

`threads-subset.txt` holds the prompt hashes of variants `48`, `48|c1200` and `48|c1600` of the first 300 items taken every fifth in id order (the snippet that wrote it is the selection in `analyze-threads.ts`).
