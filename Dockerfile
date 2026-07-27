<<<<<<< before updating
# syntax=docker/dockerfile:1.7
FROM node:24.16.0-slim AS base
||||||| last update
=======
# syntax=docker/dockerfile:1

# Keep the Node.js version in sync with .mise.toml.
FROM node:24.18.0-slim AS base
WORKDIR /app
>>>>>>> after updating
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
<<<<<<< before updating
RUN corepack enable
WORKDIR /app
||||||| last update
=======
# Node.js 25+ no longer bundles Corepack: https://github.com/nodejs/corepack
RUN npm install -g corepack@0.35.0 && npm cache clean --force && corepack enable
>>>>>>> after updating

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

<<<<<<< before updating
FROM deps AS build
||||||| last update
=======
# Local development stage. Bind-mount the repo over /app (e.g. from
# docker compose, with an anonymous volume on /app/node_modules to keep
# this image's install instead of the host's) for live-reload without
# rebuilding the image.
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
CMD ["pnpm", "dev"]

FROM deps AS builder
>>>>>>> after updating
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm run build

<<<<<<< before updating
FROM base AS prod-deps
||||||| last update
=======
# Built fresh from `base`, not `builder`, so the runtime image doesn't inherit
# dev dependencies or source files left over from the build stage.
FROM base AS runtime
ENV NODE_ENV=production
>>>>>>> after updating
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod
<<<<<<< before updating

FROM node:24.16.0-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json otel-register.mjs ./
||||||| last update
=======
COPY --from=builder /app/dist ./dist
COPY otel-register.mjs ./
>>>>>>> after updating
USER node
EXPOSE 8080
CMD ["node", "--import", "./otel-register.mjs", "dist/index.js"]
