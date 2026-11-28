# User guide

## Install

1. Open [Contextual Dictionary in the Chrome Web Store](https://chromewebstore.google.com/detail/contextual-dictionary/jdjkhefpmejijkjdknchpnghijibnali) and click **Add to Chrome**. It needs Chrome 124 or later, on a computer.
2. Pin the extension (the puzzle icon in the toolbar) so its window is one click away.

Chrome keeps it up to date; your downloads and settings stay.

If you have turned on **Enhanced protection** in Chrome's Safe Browsing settings, Chrome may first show a dialog headed "Proceed with caution" that says "This extension is not trusted by Enhanced Safe Browsing.", with the buttons **Continue to install** and **Close**. Chrome trusts extensions whose developer follows the Chrome Web Store's Developer Program Policies, and Google says a new developer generally takes a few months to become trusted ([Google's explanation](https://support.google.com/chrome_webstore/answer/2664769)); this extension's developer account is new to the store. The warning is about that account, not a report on what the extension does: before you continue you can read the [privacy page](privacy.md), the [source code](https://github.com/andrepaim/contextual-dictionary) and the [latest release](https://github.com/andrepaim/contextual-dictionary/releases/latest), which holds the ZIP file that the release workflow built from that source (it builds the ZIP twice and publishes it only if the two are identical), with its SHA-256 checksum in `SHA256SUMS.txt`.

It also installs without the store, from a ZIP file:

1. Download `contextual-dictionary-<version>.zip` from the project's [releases](https://github.com/andrepaim/contextual-dictionary/releases) and unzip it into a folder you will keep.
2. Open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked** and choose that folder.

Chrome does not update a copy installed this way: to update it, extract the new release over the same folder and click **Reload** on the extension in `chrome://extensions`. It is a separate extension from the store's, with its own downloads and settings. If you move to the store's, use **Remove** for each download in the old copy's window, then remove the old copy.

## First run

Open the extension's window from the toolbar. It offers two downloads, each with its size, and starts neither until you confirm:

- **Dictionary** (66.5 MB): English Wiktionary. Needed for any definition.
- **Context model** (189 MB to download, 207 MB on disk): needed for **Order by context**.

Both come from this project's GitHub release and are checked against published fingerprints. After that the extension works offline.

## Look a word up

Double-click a word, or select up to four words, on any ordinary web page. A small card opens next to it with the Wiktionary entries: part of speech, meanings, examples. It shows up to three entries, three meanings per entry and one example per meaning. **Show all meanings** reveals the remaining entries, meanings and examples. Press **Escape** or click elsewhere to close it. The link at the bottom opens the word on Wiktionary.

## The switches

- **Show definitions:** the card on or off everywhere.
- **Order by context:** on by default; it needs the context model, which downloads only when you confirm it. The meanings inside each entry are then listed by how well they fit the sentence you are reading, using the local model. Entries keep their dictionary order and no meaning is dropped. When the model cannot answer within three quarters of a second, or none of the meanings fits, the card keeps the dictionary's order (when the answer was only late, looking the same passage up again shows the model's order). The model loads in the background at the first lookup (two to three seconds in a new browser session) and unloads after ten idle minutes; while it is loading, cards use dictionary order. Switch it off to keep the dictionary's order and the memory the model uses.
- **Show order details:** off by default. The card then also says what the context model did to the order (see below). It works with **Order by context** on or off.
- **On <this site>:** turns the extension off for the current site only.

## Order details

With **Show order details** on, each meaning the model moved carries a small "was 3rd": its place in the dictionary's own order. Meanings in their dictionary place carry nothing. When a word has more meanings than the model was offered, a line "Not seen by the model" stands before the ones it did not see (usually after **Show all meanings**); they keep the dictionary's order. The card shows positions only, never a score: on a test set of Wiktionary's own examples, the model's first meaning is the right one about two times in three.

One line at the bottom of the card says how the meanings are ordered:

| Line | Meaning |
| --- | --- |
| Ordered by context | The model ordered the meanings; the "was" tags show what moved. |
| Ordered by context · same as dictionary order | The model's order is the dictionary's. |
| Dictionary order · ordering is off | **Order by context** is off. |
| Dictionary order · context model not installed | **Order by context** is on, but the context model is not downloaded. |
| Dictionary order · model still loading | The model is starting; the next lookups are ordered once it is ready. |
| Dictionary order · model took too long, try again | The model did not answer in time; looking the same passage up again uses its answer. |
| Dictionary order · nothing to reorder | No entry has more than one meaning. |
| Dictionary order · text does not look English | The passage does not look like English, so it is not given to the model. |
| Dictionary order · the model found no fitting meaning | The model found that none of the meanings fits the passage. |
| Dictionary order · ordering unavailable | Anything else: the model failed to start, the text could not be given to it, or the lookup was replaced by a newer one. |

## Good to know

- English only, for both the dictionary and the passage. A passage that does not look like English keeps dictionary order.
- The card cannot appear in Chrome's own pages (`chrome://…`), the Chrome Web Store, Chrome's built-in PDF viewer or text fields.
- Words with many meanings (such as "run", "set" or "draw") are ordered only among their first meanings; the rest follow in dictionary order.
- With **Order by context** on, the extension uses about 1 GB of memory more while the model is loaded.

**Remove** under each download deletes it from your computer. See [Privacy](privacy.md) for what the extension reads, keeps and sends.
