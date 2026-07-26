import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Resets vi.fn()/vi.mock() call history between tests so individual
    // test files don't need their own afterEach(() => mockClear()).
    clearMocks: true,
  },
})
