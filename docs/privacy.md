# Privacy

Contextual Dictionary shows dictionary meanings for a word you select on a web page. It does this on your computer. This page says what it reads, what it keeps and what it sends.

## What it reads

- **On the pages you visit:** when you double-click a word or select a short phrase (at most four words and 80 characters), the extension reads the selected text and up to 120 characters of the page text on each side of it, from the same paragraph or block. It reads nothing else on the page, and nothing at all when you have not selected anything, when the selection is in a text field or an editable area, when definitions are switched off, or on a site you switched off.
- That text goes from the page to the extension's own background page on your computer, where it is looked up in the dictionary and, if "Order by context" is on, given to the word-sense model, which also runs on your computer. Nothing is written to disk and nothing is logged.

## What it keeps on your computer

- **Its settings**, in the browser's extension storage: whether definitions and "Order by context" are on, the sites you switched off (their host names), and two numbers that tune the ordering (a time budget and a limit on meanings).
- **The two downloads** in the extension's private file storage: the dictionary (an English Wiktionary file, 66.5 MB) and the word-sense model (267 MB once unpacked, plus four small files). "Remove" in the extension's window deletes them.
- **A short-lived answer cache**, in memory only and gone when the browser closes: up to 64 entries, each a SHA-256 hash of a prompt and the model's numbers for it. It holds no words and no page text.
- **The last status of the downloads and the model** (phases such as "ready", sizes, error codes), in the browser's session storage, so the extension window can show it at once. It holds no words and no page text.

## What it sends

- **Only the two downloads, and only after you confirm each one.** They come from this project's GitHub release `assets-v1` (`github.com/andrepaim/contextual-dictionary/releases/download/…`, which redirects to `release-assets.githubusercontent.com`). These are ordinary file downloads: they contain nothing about you, your pages or your selections. GitHub, as the host, sees the request as it would for any download (for example your IP address).
- **Nothing else.** The extension has no telemetry, no analytics, no error reporting, no accounts and no remote code. It does not send the words you select, the page text, the addresses of the pages you visit, or your settings anywhere. It works offline once the files are downloaded.
- The card links to the word's page on Wiktionary, and the extension window links to Wiktionary and the model's page. They open only when you click them, like any link.

## Permissions and why

| Permission | Why |
| --- | --- |
| Content script on all sites (`<all_urls>`) | To notice a selection on any page and show the card next to it. It reads only the selection and its surrounding text, as described above. |
| `storage` | To keep the settings and the last status. |
| `unlimitedStorage` | To keep the 337 MB of downloaded files without the browser evicting them. |
| `offscreen` | To run the dictionary and the model in a hidden extension page with a Web Worker. |
| Host access to `github.com/andrepaim/contextual-dictionary/releases/download/*` and `release-assets.githubusercontent.com` | To download the two files you confirmed, and nothing else. |

## Contact

Questions or problems: open an issue at https://github.com/andrepaim/contextual-dictionary/issues.
