import { defineConfig } from 'vitest/config'

// Unit tests. DOM tests opt in per file with `// @vitest-environment happy-dom`.
// Files named *.entry.ts hold wiring only and are covered by the end-to-end tests.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.entry.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
})
