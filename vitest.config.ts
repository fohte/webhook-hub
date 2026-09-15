import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Resets vi.fn()/vi.mock() call history between tests so individual
    // test files don't need their own afterEach(() => mockClear()).
    clearMocks: true,
    // Spelled out (matching Vitest's own default) so knip's static analysis
    // of this file can resolve test entry files; Vitest's own runtime
    // behavior is unchanged.
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
})
