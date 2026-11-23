# Contextual Dictionary

A Chrome extension that defines the word you select on any web page and lists the meaning that fits the passage first.

- **Dictionary:** English Wiktionary, stored on your computer.
- **Order:** a local word-sense model (Ettin-150m-WSD) running in the browser on the CPU.
- **Privacy:** what you select never leaves your computer. The only network use is a one-time download of the model and the dictionary, which you confirm.

**Status: under construction.** The plan, with every task and how it is validated, is in [docs/plan.md](docs/plan.md).

## Develop

```bash
npm ci
npm run check        # secret scan, typecheck, unit tests, build
npx playwright install chromium
npm run test:e2e     # end-to-end tests with the built extension
```

Load `dist/` as an unpacked extension from `chrome://extensions` (Developer mode).

## Licences

Code: MIT ([LICENSE](LICENSE)). The dictionary data and the model have their own terms; see [NOTICE.md](NOTICE.md).
