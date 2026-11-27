# Documents

Every document of the project, with one line each. The first group describes the extension as it is now and is kept up to date; the second is a record of a point in time, kept as written.

## Current references

- [`user-guide.md`](user-guide.md): installing, the first downloads, looking a word up, the switches and the order details, for readers. Published on the site as the guide.
- [`privacy.md`](privacy.md): what the extension reads, keeps and sends, and why it needs each permission. Published on the site.
- [`assets.md`](assets.md): the GitHub releases the dictionary and the model download from, their pins, how to verify a download by hand and how to publish a new release.
- [`validation.md`](validation.md): the measurements behind the defaults (speed, accuracy, memory, release acceptance), training round 1 that made the `assets-v2` model, the best entry first on the card (on `main`, not released), and how to rerun each.
- [`pack-format.md`](pack-format.md): the dictionary pack's file format, version 1.
- [`dictionary-build.md`](dictionary-build.md): building the pack from the Kaikki.org extract, with its statistics (`dictionary-stats.json`).
- [`development.md`](development.md): building, testing and releasing; the shared core package, the site and its captures.
- [`validation/training/README.md`](../validation/training/README.md): the Python and shell scripts of training round 1, as run.
- [`packages/core/README.md`](../packages/core/README.md): the API of the shared dictionary core package.
- [`store/listing.md`](../store/listing.md): the Chrome Web Store listing text and images.
- [`NOTICE.md`](../NOTICE.md): third-party works and their licences.
- [`CLAUDE.md`](../CLAUDE.md): the developer guide: stack, structure, commands and the rules for changes.

## Records of a point in time

- [`plan.md`](plan.md): the implementation plan version 0.1.0 was built from: product decisions, architecture, module specifications, tasks and acceptance criteria.
- [`order-details-plan.md`](order-details-plan.md): the plan of the **Show order details** switch of version 0.2.0.
- [`model-runtime.md`](model-runtime.md): the first measurements of the model under WebAssembly (stage 1), superseded by `validation.md`.
