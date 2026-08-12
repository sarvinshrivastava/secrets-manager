# Known flake: tokens.test.js "scoped token can rotate a token within its scope"

**Status:** open, low priority. Not a known product bug — but do not dismiss it if it starts reproducing.

## Symptom
`server/test/tokens.test.js > "a scoped token can rotate a token within its scope (200)"`
intermittently gets **401** instead of 200.

## Observed rate
~2 failures in ~25 full-suite runs (≈8%), seen independently on two different occasions.

## What has been ruled out
- **Not reproducible in isolation:** `bun run test -- test/tokens.test.js` passed 5/5, and the
  full suite passed 3/3 immediately after a failure. Only ever fails during a full parallel run.
- **Not a short-expiry fixture.** The test's `addToken` calls pass no `expires_in_seconds`, so
  the token never expires mid-test.
- **Not a temp-DB path collision.** `tempDbPath()` uses 8 random bytes, and `beforeEach` builds a
  fresh `makeApp()` per test.
- **Not the capped bare-token scan.** The test authenticates a *named* token (`team.<secret>`),
  which resolves via `getTokenByName` and never touches `listTokens()` / `scanTokens()` — the
  only auth code changed in the commit where the flake was first noticed.

## Leading hypothesis
Load/contention artifact of the parallel run. Every auth does a 210k-iteration PBKDF2 on the
libuv threadpool; a sibling test file seeds 55 bare tokens (~2s of hashing), so threadpool
saturation is the most likely trigger. Exactly *how* that surfaces as a 401 rather than slowness
is not yet explained — that gap is the reason this note exists.

## Next steps if it recurs
1. Run with `--reporter=verbose --no-file-parallelism` to see whether serialising files makes it
   vanish (would confirm contention).
2. Log the 401 `detail` from the response body — auth returns distinct strings
   (`Missing token` / `Invalid token` / `Token has been revoked` / `Token has expired`), which
   immediately narrows the cause. The assertion currently only checks `res.status`, so the
   diagnostic string is thrown away — **assert on the body too** when investigating.
3. Check whether `openDbs` (module-level in `test/helpers.js`) can ever be cleaned up by one
   file's `afterEach` while another file is mid-test, if vitest ever shares a worker without
   isolation.
