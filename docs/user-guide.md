# User guide

## Install

1. Download `contextual-dictionary-<version>.zip` from the project's [releases](https://github.com/andrepaim/contextual-dictionary/releases) and unzip it into a folder you will keep.
2. Open `chrome://extensions`, switch on **Developer mode** (top right), click **Load unpacked** and choose that folder.
3. Pin the extension (the puzzle icon in the toolbar) so its window is one click away.

## First run

Open the extension's window from the toolbar. It offers two downloads, each with its size, and starts neither until you confirm:

- **Dictionary** (66.5 MB): English Wiktionary. Needed for any definition.
- **Context model** (147 MB to download, 271 MB on disk): needed for **Order by context**.

Both come from this project's GitHub release and are checked against published fingerprints. After that the extension works offline.

## Look a word up

Double-click a word, or select up to four words, on any ordinary web page. A small card opens next to it with the Wiktionary entries: part of speech, meanings, examples. It shows the first three meanings of each entry; **Show all meanings** lists the rest. Press **Escape** or click elsewhere to close it. The link at the bottom opens the word on Wiktionary.

## The switches

- **Show definitions:** the card on or off everywhere.
- **Order by context:** on by default; it needs the context model, which downloads only when you confirm it. The meanings inside each entry are then listed by how well they fit the sentence you are reading, using the local model. Entries keep their dictionary order and no meaning is dropped. When the model cannot answer within three quarters of a second, or none of the meanings fits, the card keeps the dictionary's order (when the answer was only late, looking the same passage up again shows the model's order). The model loads in the background at the first lookup (about three seconds in a new browser session) and unloads after ten idle minutes; while it is loading, cards use dictionary order. Switch it off to keep the dictionary's order and the memory the model uses.
- **On <this site>:** turns the extension off for the current site only.

## Good to know

- English only, for both the dictionary and the passage. A passage that does not look like English keeps dictionary order.
- The card cannot appear in Chrome's own pages (`chrome://…`), the Chrome Web Store, Chrome's built-in PDF viewer or text fields.
- Words with many meanings (such as "run", "set" or "draw") are ordered only among their first meanings; the rest follow in dictionary order.
- With **Order by context** on, the extension uses about 1 GB of memory more while the model is loaded.

**Remove** under each download deletes it from your computer. See [privacy.md](privacy.md) for what the extension reads, keeps and sends.
