// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — hence
<<<<<<< before updating
// `import './bootstrap'` as the very first statement of `src/index.ts`.
// This alone is not enough for built-in modules like `http`, though — see
// otel-register.mjs, registered via `--import` in the `start`/`dev` scripts
// and the Dockerfile's `CMD`, for why.
import {
  initObservability,
  isObservabilityConfigured,
} from '@fohte/service-kit/observability'
||||||| last update
// `import './bootstrap'` as the very first statement of `index.ts`.
// This alone is not enough for built-in modules like `http`, though — see
// otel-register.mjs: it must be preloaded via `node --import` before this
// file (or anything else) is imported, or `http.Server` is never patched.
import {
  initObservability,
  isObservabilityConfigured,
} from '@fohte/service-kit/observability'
=======
// `import './bootstrap'` as the very first statement of `index.ts`.
// This alone is not enough for built-in modules like `http`, though — the
// `--import @fohte/service-kit/otel-register` flag on the start/dev scripts
// must preload it before this file (or anything else) is imported, or
// `http.Server` is never patched.
import { initObservabilityIfConfigured } from '@fohte/service-kit/observability'
>>>>>>> after updating

initObservabilityIfConfigured(process.env)
