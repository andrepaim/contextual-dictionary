# Plan: order details (version 0.2.0)

> **Status:** shipped in 0.2.0 (#17, merged on 2026-11-24). The switch, its default and the status lines are as described here (`src/content/order-details.ts`, `src/popup/popup.ts`). One statement has not held since 0.3.0: with the switch off, the card is no longer the 0.1.0 card, because 0.3.0 (#21) moved it to the shared card stylesheet and preview of `packages/core/`. **Since 2026-11-27 (on `main`, not yet released):** the entry holding the model's best meaning can move to the top (`docs/validation.md`, "The best entry first"); with the switch on, its heading carries "was 2nd entry" (`data-part="entry-was"`, class `dc-was`), its dictionary position among the entries; the entries it passed carry nothing, a move of an entry alone makes the status "Ordered by context", and `OrderDetails` gains `entryPositions`. Reordering entries is no longer out of scope (section 11).

A fourth switch in the extension's window, **Show order details**, off by default. When it is on, the card says what the context model did to the order of the meanings: which meanings moved and from where, which ones the model never saw, and, when the card shows dictionary order, why.

## 1. Why

Today the card looks the same whether the model reordered the meanings, agreed with the dictionary, was still loading, ran out of time or refused the text. A reader cannot tell which, and neither can we when someone reports a wrong order. A meaning's dictionary position is a fact the reader can check; it shows the reordering without claiming the model is right.

## 2. Decisions

- **Positions, not scores.** No probability, percentage or confidence is shown anywhere. The model puts the right meaning first about 64% of the time (`docs/validation.md`); a number would look more certain than it is. This keeps the rule of `docs/plan.md`: no score is shown.
- **No timings** in the card.
- **Off by default.** With the switch off, the card's DOM and appearance are exactly what they are in 0.1.0.
- **The details are always computed and sent with the answer**; the switch only decides whether the card shows them. They hold numbers and one status word, no text, and nothing new is stored or sent off the computer.
- **Name:** "Show order details" (setting key `showOrderDetails`).
- **The switch is always available**, also when "Order by context" is off; the card then says that ordering is off.

## 3. What the reader sees (switch on)

1. **Per meaning, a tag "was 3rd"** (`data-part="was"`), small and muted, after the definition text, on every meaning whose position in its entry differs from its dictionary position. Ordinals in English: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 101st, 111th.
2. **A divider before the meanings the model was not offered** (`data-part="unranked"`), text "Not seen by the model", inside an entry's list, only when the entry has such meanings and they are visible (usually after "Show all meanings"). Meanings after it carry no tag: they are in dictionary order among themselves.
3. **One status line** (`data-part="order-status"`) at the top of the card's footer:

| Status | Text |
| --- | --- |
| `ordered`, some meaning moved | Ordered by context |
| `ordered`, nothing moved | Ordered by context · same as dictionary order |
| `off` | Dictionary order · ordering is off |
| `no-model` | Dictionary order · context model not installed |
| `loading` | Dictionary order · model still loading |
| `timed-out` | Dictionary order · model took too long, try again |
| `nothing-to-order` | Dictionary order · nothing to reorder |
| `not-english` | Dictionary order · text does not look English |
| `none-fits` | Dictionary order · the model found no fitting meaning |
| `unavailable` | Dictionary order · ordering unavailable |

The tag and the status line meet the card's contrast rule (at least 4.5:1 in both colour schemes), use `textContent` only, and the card stays inside its 360-pixel height limit and its placement rules.

## 4. Contracts (`src/shared/contracts.ts`, additive)

```ts
export type OrderStatus = 'ordered' | 'off' | 'no-model' | 'loading' | 'timed-out' | 'nothing-to-order' | 'not-english' | 'none-fits' | 'unavailable'

export interface OrderDetails {
  status: OrderStatus
  /**
   * Only with status 'ordered'. positions[e][i] is the 0-based dictionary
   * position of result.entries[e].senses[i], the meaning now at place i.
   */
  positions?: number[][]
  /**
   * Only with status 'ordered'. offered[e] is how many meanings of entry e
   * the model was offered; they are the first offered[e] of the answer's
   * senses. The rest follow in dictionary order.
   */
  offered?: number[]
}

export interface DefineAnswer { result: DictionaryResult; ordered: boolean; order?: OrderDetails }
export interface Settings { /* … */ showOrderDetails: boolean }   // default false
```

- `DEFAULT_SETTINGS.showOrderDetails = false`; `normalizeSettings` keeps a boolean and falls back to the default; `isRequest` accepts `showOrderDetails` in a `set-settings` patch as a boolean only.
- `Ranker` gains `rank(result, selection, signal?): Promise<{ result: DictionaryResult; details: OrderDetails }>`. `order()` stays and returns `rank()`'s result.
- `ordered` keeps its meaning (`order.status === 'ordered'`).
- An answer without `order`, or with details that do not match the result (wrong lengths, positions that are not a permutation), is shown without details: never throw, never show wrong tags.

## 5. Where each status comes from

| Status | Decided in | When |
| --- | --- | --- |
| `off` | offscreen host | "Order by context" is off |
| `no-model` | offscreen host | ordering is on, the ranker is not ready and the model is not installed |
| `nothing-to-order` | host or ranker | the result has no entry with two meanings (skip `NO_ENTRIES`, `SINGLE_SENSES`) |
| `loading` | ranker | the model is idle or loading (the lookup starts the load) |
| `not-english` | ranker | skip `NOT_ENGLISH` |
| `timed-out` | ranker | the budget ran out before the answer |
| `none-fits` | ranker | `contextualOrder` reason `NONE_FITS` |
| `ordered` | ranker | `contextualOrder` applied; `positions` and `offered` come from it |
| `unavailable` | ranker or host | everything else: failed or closed model, other skip reasons, invalid scores, a superseded or cancelled lookup, any error |

`contextualOrder` returns the positions and the offered counts with an applied outcome, so they are computed where the order is made. A cached answer gives the same details as a fresh one.

## 6. Modules and changes

- `src/shared/contracts.ts`: section 4. `src/shared/offscreen-protocol.ts`, `messaging.ts`: no change expected; check the answer passes through untouched.
- `src/sense/prompt.ts`: `contextualOrder` also returns `positions` and `offered` when applied.
- `src/sense/ranker.ts`: `rank()` with the statuses of section 5; `order()` delegates; the statistics counters keep their meaning.
- `src/offscreen/host.ts`: `#define` uses `rank()` and fills `order` on every answer.
- `src/content/controller.ts`: the activation state carries `showOrderDetails`; the controller passes `answer.order` to the card only when it is on; a settings change applies to the next lookup (an open card need not change).
- `src/content/card.ts`: `showResult(result, anchor, details?)`; section 3; "Show all meanings" keeps working with tags and the divider; validation of the details as in section 4.
- `src/popup/popup.ts`: the switch "Show order details" (`data-control="showOrderDetails"`) below "Order by context", sending `set-settings`.
- `src/background/`: settings pass through `normalizeSettings`; check stored settings from 0.1.0 (without the key) load with the default.
- The fake model worker of the end-to-end build must let a test produce a real reorder (it does today for "mouse"; reuse it).

## 7. Tests (written first, each failing before its change)

Unit (`test/unit/`, mirroring `src/`):
- contracts: default, `normalizeSettings` (missing, wrong type), `isRequest` patch (boolean accepted, other types refused).
- prompt: `contextualOrder` positions and offered counts; ties keep dictionary order (positions are the identity); entries with meanings not offered.
- ranker: one test per status of section 5, including a cached answer, a superseded lookup and an aborted one; `order()` unchanged.
- host: `off`, `no-model`, `nothing-to-order`; `order` present on every answer; `ordered` consistent with `order.status`.
- card: with details, each row of the table in section 3; tags only on moved meanings; ordinals; the divider only where meanings were not offered and visible; "Show all meanings" and "Show fewer" with details; malformed details shown as none; **without details the DOM equals today's** (an explicit comparison).
- controller: details reach the card only when the setting is on; turning it on or off applies to the next lookup.
- popup: the switch reflects the setting and sends the patch.

End-to-end (`test/e2e/`, fake model): switch on → the card of a reordered word shows a "was" tag and "Ordered by context"; switch off → none of the three parts exist; ordering off with details on → "Dictionary order · ordering is off"; model not installed → "context model not installed"; the setting survives a browser restart.

Coverage stays above the thresholds (85% lines, 80% branches); `npm run check` and `npm run test:e2e` pass.

## 8. Documents

- `README.md` (Use: four switches, one sentence on the details), `docs/user-guide.md` (a short section with the table of section 3), `docs/privacy.md` (the new setting in "What it keeps"; state that the details are numbers, not text), `store/listing.md` (the description's "HOW IT WORKS" list gains one line), `site/index.html` unchanged unless a sentence there becomes wrong, `CLAUDE.md` only if a rule or the structure changes, `docs/plan.md`: a line under product decisions pointing here.

## 9. Version and release

- `package.json` and `package-lock.json` to **0.2.0** in the same pull request.
- The implementing agent merges the pull request once CI is green and does **not** tag or release. The tag `v0.2.0` is pushed after the merged build has been checked with the real model.

## 10. Acceptance

1. Switch off: screenshots and DOM of the card unchanged from 0.1.0 (the existing end-to-end tests pass unmodified).
2. Switch on, real model, "moment" in "And enterprises of great pith and moment": the first meaning "(figurative) Weight or importance." carries a "was" tag with its dictionary position, and the status reads "Ordered by context".
3. Switch on, "Order by context" off: "Dictionary order · ordering is off", no tags.
4. Switch on, first lookup right after the browser starts: "Dictionary order · model still loading", then "Ordered by context" on a repeat.
5. No score, percentage or timing appears in the card in any state.
6. `npm run check`, `npm run test:e2e`, the release dry run and the reproducible ZIP check pass at 0.2.0.

## 11. Out of scope

Reordering entries (river "bank"), an adaptive prompt limit, scores, timings, statistics over time, any change to the model, the dictionary or the published assets.
