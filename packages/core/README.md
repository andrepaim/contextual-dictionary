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

`isSenseFormat` validates prompt metadata. `contextualOrder` preserves the original result on unusable scores or when the model chooses “none of the above.” Applied orders include the original position of each sense and the number offered per entry. Callers handle storage, asset verification, inference, scheduling and UI.

`@andrepaim/contextual-dictionary-core/pack` exports `writePack`, `PackWriter` and the v1 pack record types. Supply records in `compareKeys` order when writing a pack for tests or tools.

The npm tarball contains built JavaScript and types and installs with lifecycle scripts disabled. It has zero npm dependencies. The caller supplies the dictionary pack separately. See the repository's `docs/assets.md` for the Wiktionary pack and attribution.
