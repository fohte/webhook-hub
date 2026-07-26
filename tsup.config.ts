import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  // Bundle first-party code; keep node_modules external so production deps are
  // installed via pnpm and not duplicated into the image.
  bundle: true,
  skipNodeModulesBundle: true,
  // skipNodeModulesBundle externalizes any non-relative specifier, including
  // `#`-prefixed subpath imports (package.json "imports" field) — force those
  // back into the bundle since they resolve to first-party src/, not a package.
  noExternal: [/^#/],
})
