# syntax=docker/dockerfile:1

# ---- Frontend build ----------------------------------------------------------
# Pin the base image by digest-free tag; bump deliberately. node:20-bookworm-slim
# floats — if you want fully reproducible rebuilds, replace with a digest
# (node:20-bookworm-slim@sha256:...).
FROM node:20-bookworm-slim AS frontend-build

WORKDIR /app/frontend
# Copy lockfile too and use `npm ci` for reproducible, lockfile-exact installs.
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Server dependencies -----------------------------------------------------
# better-sqlite3 is a native module. node:20-bookworm-slim ships prebuilt
# binaries for linux x64/arm64 via prebuild-install, so `npm ci` normally needs
# no toolchain. If the build ever fails compiling better-sqlite3, add:
#   RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
FROM node:20-bookworm-slim AS server-deps

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---- Runtime -----------------------------------------------------------------
FROM node:20-bookworm-slim

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
