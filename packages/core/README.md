# Contextual Dictionary Core

`@andrepaim/contextual-dictionary-core` is an ESM package for Node.js 22 and Chromium. It opens a version 1 Wiktionary pack through a caller-provided `ByteSource` and provides pure functions to construct compact-v1 prompts and apply scores from a caller-provided model.

```ts
import {
  contextualOrder, openWiktionaryDictionary, senseRequest, SENSE_PROMPT_DEFAULTS,
  type ByteSource, type Selection, type SenseFormat,
} from '@andrepaim/contextual-dictionary-core'

async function define(source: ByteSource, selection: Selection, format: SenseFormat,
                      score: (prompt: string) => Promise<Float32Array>) {
  const dictionary = await openWiktionaryDictionary(source)
  const result = await dictionary.define(selection)
  const { maxCandidates, maxPromptChars } = SENSE_PROMPT_DEFAULTS
  const request = senseRequest(result, selection, format, maxCandidates, maxPromptChars)
  if ('skip' in request) return result
  return contextualOrder(result, request, await score(request.prompt), format).result
}
```

`ByteSource.read(start, end)` returns exactly `end - start` bytes, with `end` exclusive. Define and order use the same `Selection` shape. Context is optional and its whitespace marks word boundaries. Preserve whitespace when passing text from either side of the selection. Open the dictionary once and reuse it for lookups to benefit from the block cache.

`isSenseFormat` validates prompt metadata. `contextualOrder` preserves the original result on unusable scores or when the model chooses “none of the above.” Applied orders include the original position of each sense, the number offered per entry and the original position of each entry (`entryPositions`). Callers handle storage, asset verification, inference, scheduling and UI.

By default `contextualOrder` reorders the meanings inside each entry and leaves the entries in dictionary order. Its optional fifth argument, `{ bestEntryFirst: true, entryMargin }` (since 0.3.0), also moves the entry that holds the best-scored meaning to the first place; the other entries keep dictionary order among themselves. The entry moves only when that meaning's probability (the softmax over the offered meanings and “none of the above”) is at least `entryMargin` above the best probability among the first entry's offered meanings; the default margin is 0. Nothing moves when the model chooses “none of the above” or the scores are unusable. In an applied order, `positions`, `offered` and `entryPositions` all follow the result's entries in their new order:

```ts
const order = contextualOrder(result, request, logits, format, { bestEntryFirst: true, entryMargin: 0.1 })
if (order.applied && order.entryPositions[0] !== 0) {
  // order.result.entries[0] was entry number order.entryPositions[0] + 1 in dictionary order.
}
```

`@andrepaim/contextual-dictionary-core/pack` exports `writePack`, `PackWriter` and the v1 pack record types. Supply records in `compareKeys` order when writing a pack for tests or tools.

## Definition card

```ts
import { cardPreview } from '@andrepaim/contextual-dictionary-core/card'
import { cardFixture } from '@andrepaim/contextual-dictionary-core/card-fixture'

const { entries, canExpand } = cardPreview(cardFixture.entries, false)
```

`cardPreview` accepts the result's entries in display order and the current expanded state. The collapsed view includes up to three entries, three meanings per entry and one example per meaning. Pass `true` for the complete view. `canExpand` is true if collapsing hides any entry, meaning or example, so the toggle can remain visible in both states. Each view entry and sense holds the original dictionary object. Iterate the separate `examples` array on each view sense for the visible examples. `cardFixture` is a synthetic `DictionaryResult` that exercises all three limits.

Load `@andrepaim/contextual-dictionary-core/card.css` as a stylesheet or through your bundler's CSS text loader for a shadow root. The root `.dc-card` contains a scrollable `.dc-body` and a `.dc-footer` that stays visible. Use `.dc-entry` for each entry, `.dc-head` with `.dc-lemma` and `.dc-pos` for its heading, `.dc-note` for an optional note, and `.dc-senses` on its ordered list. Use `.dc-definition` and `.dc-example` in each list item. The footer styles `.dc-toggle`, `.dc-attribution` and an optional `.dc-status`. `.dc-was` and `.dc-unranked` style optional ordering details.

The stylesheet gives the card a 340px width and light and dark defaults. Override `--dc-bg`, `--dc-text`, `--dc-muted`, `--dc-border`, `--dc-accent` and `--dc-shadow` on the card or an ancestor to match the host theme. The host provides markup, placement, maximum height and interactions. The main package import remains the dictionary and ordering engine.

The npm tarball contains built JavaScript and types and installs with lifecycle scripts disabled. It has zero npm dependencies. The caller supplies the dictionary pack separately. See the repository's `docs/assets.md` for the Wiktionary pack and attribution.
