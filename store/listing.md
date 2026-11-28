# Chrome Web Store listing

Everything to paste into the Chrome Web Store Developer Dashboard, and the images to upload. Published at https://chromewebstore.google.com/detail/contextual-dictionary/jdjkhefpmejijkjdknchpnghijibnali. The images are made by `validation/store-assets.ts` from the built extension with the real dictionary and model.

## Package

Upload `contextual-dictionary-<version>.zip` from the [release](https://github.com/andrepaim/contextual-dictionary/releases) of that version. The store reads the name, the summary and the version from its manifest.

## Store listing

| Field | Value |
| --- | --- |
| Name (from the manifest) | Contextual Dictionary |
| Summary (from the manifest) | Select a word on any page to see its dictionary meanings, with the one that fits the passage first. Runs on your computer. |
| Category | Education ("Tools" as the alternative) |
| Language | English |
| Homepage URL | https://andrepaim.github.io/contextual-dictionary/ |
| Official URL (optional) | https://andrepaim.github.io/contextual-dictionary/, once it is verified in Google Search Console (see below) |
| Support URL | https://github.com/andrepaim/contextual-dictionary/issues |

### Detailed description

```
Double-click a word on any web page and a card opens beside it with the word's meanings from the English Wiktionary. The meaning that fits the sentence you are reading is listed first.

Most dictionary extensions show meanings in the dictionary's own order, so you read through five of them to find the one you need. Contextual Dictionary reads the sentence around the word and puts the best fit at the top.

An example: in Hamlet's "enterprises of great pith and moment", Wiktionary lists "moment" as a point in space, then a point in time. Contextual Dictionary opens on "Weight or importance", which is what Hamlet means.

HOW IT WORKS
• Double-click a word, or select up to four words, on an ordinary web page.
• A card shows up to three entries, three meanings per entry and one example per meaning. "Show all meanings" reveals the rest.
• Press Escape or click elsewhere to close it.
• Switch it off for a single site, or switch off the ordering, from the extension's window.
• Turn on "Show order details" to see where each moved meaning was in the dictionary's order.

PRIVATE BY DESIGN
• The dictionary and the word-sense model both run on your computer.
• The words you select and the pages you read are never sent anywhere.
• No account, no analytics, no telemetry.
• Works offline after setup.

SETUP
The first time you open the extension's window it offers two downloads, and each one asks for your confirmation:
• Dictionary: 66.5 MB. About 1.2 million English headwords with examples.
• Context model: 189 MB. Needed only for ordering by context.
• Updating from an earlier version: 0.4.0 has a new context model. The window asks you once to confirm its download (185 MB); until then cards keep the dictionary's order. The dictionary is kept.

GOOD TO KNOW
• English only.
• The ordering is a help, not an oracle. On 2,300 test sentences it put the right meaning first 64% of the time, against 28% for dictionary order. No meaning is ever hidden.
• While the model is in use the extension needs about 1 GB of memory. It is released after ten idle minutes.
• It does not run on Chrome's own pages, the Chrome Web Store, PDFs or inside text fields.

OPEN SOURCE
Code under the MIT licence: https://github.com/andrepaim/contextual-dictionary
Definitions from Wiktionary (CC BY-SA 4.0), via Kaikki.org. Model: fine-tuned from Ettin-150m-WSD (Apache-2.0) on Wiktionary examples.
```

### Images

| Slot | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` | 128 × 128, artwork 100 × 100 on a transparent margin |
| Screenshot 1 | `screenshot-1-context.png` | 1280 × 800 |
| Screenshot 2 | `screenshot-2-compare.png` | 1280 × 800 |
| Screenshot 3 | `screenshot-3-any-page.png` | 1280 × 800 |
| Screenshot 4 | `screenshot-4-details.png` | 1280 × 800 |
| Screenshot 5 | `screenshot-5-private.png` | 1280 × 800 |
| Small promo tile | `promo-small-440x280.png` | 440 × 280 |
| Marquee promo tile (optional) | `promo-marquee-1400x560.png` | 1400 × 560 |
| Promo video (optional) | a YouTube link: upload `site/media/contextual-dictionary.webm` to YouTube and paste its address | 1920 × 1080, 37 s, no sound |

Screenshots 1, 2 and 4 show `shakespeare.mit.edu/hamlet/hamlet.3.1.html` (4 with "Show order details" on); 3 shows a demonstration page written for this purpose; 5 shows the extension's window. They were taken with version 0.4.0. The cards and the window are captures of the running extension, set in a frame with a headline. The screenshots are 24-bit PNG without transparency, as the store asks. The promo video is the film of the project site, a recording of the extension on the site's practice page made by `validation/site-video.ts`; the store takes it only as a YouTube link.

## Privacy tab

### Single purpose

```
Shows dictionary definitions for the word or short phrase the user selects on a web page, with the meaning that fits the surrounding sentence listed first.
```

### Permission justifications

| Permission | Justification |
| --- | --- |
| `storage` | Keeps the user's settings (definitions on or off, ordering on or off, order details on or off, sites switched off) and the last status of the downloads. |
| `unlimitedStorage` | Keeps the downloaded dictionary (66.5 MB) and word-sense model (about 207 MB) in the extension's private file storage so the browser does not evict them. |
| `offscreen` | Runs the dictionary lookup and the word-sense model in a hidden extension page with a Web Worker and WebAssembly threads, which a service worker cannot do. |
| Host permission `https://github.com/andrepaim/contextual-dictionary/releases/download/*` and `https://release-assets.githubusercontent.com/*` | Downloads the dictionary and the model files from this project's GitHub release, once, after the user confirms each download. They are data files checked against SHA-256 digests pinned in the extension; no code is downloaded. |
| Content script on all sites (`<all_urls>`) | A dictionary has to work on whatever page the user is reading. The script waits for a double-click or a short selection, reads the selected text and up to 120 characters on each side of it, and shows the card. It reads nothing else and sends nothing off the device. |

### Remote code

```
No, I am not using remote code. All JavaScript and WebAssembly is inside the package. The two downloads are data: a dictionary file and an ONNX model, each verified against a SHA-256 digest pinned in the extension.
```

### Data usage

The extension transmits no user data. It does read the selected text and the text around it on the page, and processes them on the device only. The cautious answer on the form is to tick **Website content** and nothing else, since that text is used, though never collected or sent. Then tick all three certifications; each is true:

- User data is not sold or transferred to third parties.
- User data is not used or transferred for purposes unrelated to the single purpose.
- User data is not used or transferred to determine creditworthiness or for lending.

### Privacy policy URL

https://andrepaim.github.io/contextual-dictionary/privacy.html

The page is made from `docs/privacy.md` when the site is built.

## Official URL

The store offers as "Official URL" only sites verified in Google Search Console with the same Google account. To verify the project site: add the property `https://andrepaim.github.io/contextual-dictionary/` in Search Console as a URL prefix, choose the HTML file method, put the file it gives you in `site/` and merge it; the site is published again and the file is served from the site's root. (The HTML tag method works too: put the tag in the head of `site/index.html`.)

## Distribution

Free, public, all regions.

## Notes for the review

- A content script on all sites usually means a longer, in-depth review.
- If a reviewer asks about the downloads: they are data files from this repository's release `assets-v2`, described in `docs/assets.md` and `docs/privacy.md`.
- Each upload needs a higher version than the last; the release workflow enforces that the tag equals the version.

## Enhanced Safe Browsing warning

People who have Enhanced protection on in Chrome see a dialog headed "Proceed with caution" that says "This extension is not trusted by Enhanced Safe Browsing." when they install the extension ([issue #38](https://github.com/andrepaim/contextual-dictionary/issues/38)). Google trusts an extension when its developer follows the Developer Program Policies, and a new developer generally takes a few months ([Google's help page](https://support.google.com/chrome_webstore/answer/2664769)), so this status is a matter of the developer account's age and conduct. Nothing in the listing or the package changes it, and Google gives no date. To check it, install from the store in a Chrome profile with **Settings > Privacy and security > Security > Enhanced protection** selected: while the account is not trusted the dialog above appears, and once it is trusted Chrome asks only to **Add extension**. The guide and the home page explain the warning to readers.
