# Docker build gotchas (Node + native/optional deps)

Hard-won while getting `docker compose build` green for this repo. All three bit in sequence.

## 1. `better-sqlite3@13` needs Node >= 22 AND has no prebuilt binary for every target
- v13's `engines` require Node >= 22 → building on `node:20-*` fails outright (`EBADENGINE`, and no Node-20 ABI prebuild exists).
- Even on Node 22, there is **no usable prebuilt binary** for some targets (e.g. linux/arm64), so `prebuild-install` falls back to `node-gyp` source compilation, which needs `python3 make g++` — absent from `-slim` images.
- Fix here: all Dockerfile stages on `node:22-bookworm-slim`, and `python3 make g++` added to the **server-deps stage only** (final runtime image stays slim — only `node_modules` is copied out).

## 2. A macOS-generated `package-lock.json` breaks `npm ci` in a linux image
- `npm install` (or `bun add`, which doesn't touch package-lock at all) run on macOS produces a lockfile that **omits the linux `@rollup/rollup-*` and `@esbuild/*` optional binaries**.
- Symptoms, in order as you fix each:
  - `npm ci` → `Missing: esbuild@X from lock file` (lock/package.json out of sync).
  - after that resolves → `npm ci` OK but `vite build` dies in `rollup/dist/native.js` (`requireWithFriendlyError`) — the linux rollup native module isn't installed.
- `npm install --package-lock-only` does **not** fix it — it doesn't fully resolve optional platform deps.
- **Fix: regenerate the lock with a full `npm install` inside a linux `node:22` container**, isolated so it doesn't clobber the host's node_modules:
  ```sh
  docker run --rm -v "$PWD/frontend/package.json:/src/package.json:ro" node:22-bookworm-slim \
    sh -c "mkdir -p /w && cp /src/package.json /w/ && cd /w && npm install >/dev/null 2>&1 && cat package-lock.json" \
    > frontend/package-lock.json
  ```
  The resulting lock records **all** platforms' optional deps (verify: `grep -c '@rollup/rollup-linux' package-lock.json` and `@esbuild/linux` are non-zero). macOS `npm ci` and local `bun run build` still work with it — it's a superset.
- `bun`/`bun add` updates `package.json` but never `package-lock.json`. If the Docker image uses `npm ci`, an agent/dev adding deps via bun silently desyncs the lock. Keep them in sync or the image won't build.

## 3. Verify the build by actually running it — don't trust exit codes through a pipe
- `docker compose build 2>&1 | tail -6; echo rc=$?` reports the **tail's** exit code (0), not the build's. The build had failed.
- `docker compose build >log 2>&1; echo rc=$?` (no pipe) gives the real code; use `--progress=plain` to get full, untruncated error output for grepping.
