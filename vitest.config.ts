import { defineConfig } from 'vitest/config'

<<<<<<< before updating
export default defineConfig({
  test: {
    // Resets vi.fn()/vi.mock() call history between tests so individual
    // test files don't need their own afterEach(() => mockClear()).
    clearMocks: true,
  },
})
||||||| last update
export default defineConfig({
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
=======
export default defineConfig({})
>>>>>>> after updating
