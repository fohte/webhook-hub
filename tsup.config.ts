import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Keep in sync with the node version in .mise.toml.
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle first-party code; keep node_modules external so
  // @opentelemetry/auto-instrumentations-node's module-patching hook still
  // applies to the real package in node_modules instead of a bundled copy.
  bundle: true,
  skipNodeModulesBundle: true,
  // skipNodeModulesBundle externalizes any non-relative specifier, including
  // `#`-prefixed subpath imports (package.json "imports" field) — force those
  // back into the bundle since they resolve to first-party src/, not a package.
  noExternal: [/^#/],
})
