# syntax=docker/dockerfile:1

# ---- Frontend build ----------------------------------------------------------
# Pin the base image by digest-free tag; bump deliberately. node:22-bookworm-slim
# floats — if you want fully reproducible rebuilds, replace with a digest
# (node:22-bookworm-slim@sha256:...).
FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app/frontend
# Copy lockfile too and use `npm ci` for reproducible, lockfile-exact installs.
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Server dependencies -----------------------------------------------------
# better-sqlite3 is a native module and requires Node >=22 (node:20 fails). When
# prebuild-install can't fetch a matching prebuilt binary for the target
# (Node-22 ABI / this arch), it falls back to compiling from source with
# node-gyp, which needs python3 + a C++ toolchain that -slim does NOT ship
# (-> "Could not find any Python installation" / gyp ERR). We install the
# toolchain here so the build is robust whether or not a prebuild is available.
# This is a throwaway build stage: only /app/server/node_modules is copied into
# the runtime image, so the compiler bloat never reaches the final image.
FROM node:22-bookworm-slim AS server-deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- Runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8000

CMD ["node", "server/src/index.js"]
