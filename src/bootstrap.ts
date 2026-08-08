// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — hence
// `import './bootstrap'` as the very first statement of `index.ts`.
// This alone is not enough for built-in modules like `http`, though — the
// `--import @fohte/service-kit/otel-register` flag on the start/dev scripts
// must preload it before this file (or anything else) is imported, or
// `http.Server` is never patched.
import { initObservabilityIfConfigured } from '@fohte/service-kit/observability'

// registerSignalHandlers is disabled here because `#shutdown` (wired up in
// index.ts) is the single SIGTERM/SIGINT owner for the process; this handle's
// `shutdown()` runs as one of its ordered steps instead.
export const observability = initObservabilityIfConfigured(process.env, {
  registerSignalHandlers: false,
})
