# Contextual Dictionary

A Chrome extension that defines the word you select on any web page and lists the meaning that fits the passage first.

- **Dictionary:** English Wiktionary, stored on your computer.
- **Order:** a local word-sense model (Ettin-150m-WSD) running in the browser on the CPU.
- **Privacy:** what you select never leaves your computer. The only network use is a one-time download of the model and the dictionary, which you confirm.

**Status: under construction.** The plan, with every task and how it is validated, is in [docs/plan.md](docs/plan.md).

## Develop

```bash
npm ci
npm run check        # secret scan, typecheck, unit tests, build, build check
npx playwright install chromium
npm run test:e2e     # end-to-end tests with the built extension (builds dist/ and dist-e2e/)
npm run package      # package/contextual-dictionary-<version>.zip and SHA256SUMS.txt
```

Load `dist/` as an unpacked extension from `chrome://extensions` (Developer mode).

## Release

Pushing a tag `v<version>` (equal to `version` in `package.json`) runs `.github/workflows/release.yml`: every check, then the reproducible ZIP built twice, then a GitHub release with the ZIP and `SHA256SUMS.txt`. Run the workflow by hand for a dry run that stops before publishing.

## Licences

Code: MIT ([LICENSE](LICENSE)). The dictionary data and the model have their own terms; see [NOTICE.md](NOTICE.md).
