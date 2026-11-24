import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests. DOM tests opt in per file with `// @vitest-environment happy-dom`.
// Files named *.entry.ts hold wiring only and are covered by the end-to-end tests.
export default defineConfig({
  // Cover the TypeScript sources. The package check and Chromium exercise the installed JS.
  resolve: {
    alias: [
      { find: /^@andrepaim\/contextual-dictionary-core$/, replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
      { find: /^@andrepaim\/contextual-dictionary-core\/pack$/, replacement: fileURLToPath(new URL('./packages/core/src/pack.ts', import.meta.url)) },
      { find: /^@andrepaim\/contextual-dictionary-core\/card$/, replacement: fileURLToPath(new URL('./packages/core/src/card.ts', import.meta.url)) },
      { find: /^@andrepaim\/contextual-dictionary-core\/card-fixture$/, replacement: fileURLToPath(new URL('./packages/core/src/card-fixture.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    css: { include: [/\/contextual-dictionary-core\/dist\/card\.css(?:\?|$)/] },
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'packages/core/src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.entry.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
})
