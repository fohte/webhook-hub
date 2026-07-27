import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
<<<<<<< before updating
||||||| last update
=======
  // Keep in sync with the node version in .mise.toml.
>>>>>>> after updating
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
<<<<<<< before updating
  splitting: false,
  sourcemap: true,
  // Bundle first-party code; keep node_modules external so production deps are
  // installed via pnpm and not duplicated into the image.
  bundle: true,
||||||| last update
=======
  // Bundle first-party code; keep node_modules external so
  // @opentelemetry/auto-instrumentations-node's module-patching hook still
  // applies to the real package in node_modules instead of a bundled copy.
>>>>>>> after updating
  skipNodeModulesBundle: true,
<<<<<<< before updating
  // skipNodeModulesBundle externalizes any non-relative specifier, including
  // `#`-prefixed subpath imports (package.json "imports" field) — force those
  // back into the bundle since they resolve to first-party src/, not a package.
  noExternal: [/^#/],
||||||| last update
=======
>>>>>>> after updating
})
