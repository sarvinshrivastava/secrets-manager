# Secret Manager — Proposals & Design Decisions

---

## [PROPOSAL-001] Flexible Runtime Token Management

**Status:** Discussed, pending implementation
**Priority:** High

### Problem
Current token system has two hard constraints:
1. Token identity is fixed at startup — only `admin` and `reader`, loaded from env vars
2. No runtime token lifecycle — no create, revoke, rotate, or expire without restarting the server

### Proposed Solution: Runtime Token Management (No Compromise on Crypto)

#### Schema Change
Add two columns to the `tokens` table:
```sql
-- existing: name, role, salt, token_hash, created_at, updated_at
-- add:
expires_at  TEXT,        -- NULL = never expires, ISO 8601 if set
revoked_at  TEXT         -- NULL = active, set = revoked (tombstone, not delete)
```
> Tombstone over DELETE: preserves audit trail — you know a token WAS revoked, by whom, and when.

#### New API Endpoints (write-role only, internal traffic only)
| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/tokens` | List all tokens (no raw values, ever) |
| `POST` | `/api/tokens` | Create a new token with name, role, optional TTL |
| `DELETE` | `/api/tokens/:name` | Revoke a token immediately |
| `POST` | `/api/tokens/:name/rotate` | Rotate (revoke old, issue new value) |

**Create token request body:**
```json
{
  "name": "ci-pipeline",
  "role": "read",
  "expires_in_seconds": 86400
}
```
> Raw token value returned ONLY once at creation — never stored, never retrievable again (same model as GitHub PATs, Vault tokens).

#### Auth Middleware Changes
Two additions to verification path (pure reads, zero new attack surface):
1. Check `revoked_at IS NULL` → 401 if revoked
2. Check `expires_at IS NULL OR now < expires_at` → 401 if expired

PBKDF2 verification stays identical.

#### Bootstrap Token Change
- Keep env-var bootstrap but mark tokens as `bootstrapped`
- If `SECRET_MANAGER_ADMIN_TOKEN` is missing at startup BUT at least one write token exists in DB → skip bootstrap (don't crash)
- Removes hard coupling between env vars and runtime state
- Bootstrap tokens can still be rotated/revoked via API without server restart

#### What Does NOT Change
- PBKDF2-SHA256 with 210,000 iterations + random salt
- `timingSafeEqual` verification
- RBAC (read/write roles)
- Audit logging (extended to cover token lifecycle events)
- Rate limiting

#### Explicitly NOT Proposed
| Idea | Reason |
|---|---|
| JWT | Stateless = can't revoke mid-lifetime without a denylist (defeats the point) |
| OAuth2/OIDC | Massive scope creep for a self-hosted secrets manager |
| Sessions/cookies | Adds CSRF attack surface with no benefit over token auth |
| Password auth | No user model exists; token-based is correct for machine access |

---

## [PROPOSAL-002] Public-Facing Route Isolation + Folder-Scoped Secret Fetch

**Status:** Discussed, pending implementation
**Priority:** Blocking (required before go-live on VPS)

### Context
This service runs 24/7 on a public VPS and is consumed by GitHub Actions runners for
automated testing. GitHub Actions IPs are dynamic and unpredictable — IP allowlisting
is not a viable strategy. The public endpoint is the only internet-reachable surface.

### Requirements
1. Only `GET /api/secrets/:folder/:key` is public-facing — all other routes are internal only
2. Rate limiting is scoped exclusively to this public endpoint (not global)
3. Folder-level scope on the GET endpoint (same key name can exist in different folders)
4. Auth is NOT removed — public-facing ≠ unauthenticated (read token still required)

### Route Design

**Before:**
```
GET /api/secrets/:key       — no folder scope, flat key lookup
```

**After:**
```
GET /api/secrets/:folder/:key   — fetch secret by folder + key (public-facing)
```
> Path param over query param: cleaner, cache-friendly, avoids accidental query string logging.
> No backward-compat with flat `:key` route — breaking change is intentional and clean.

### Prerequisite: Schema Redesign (Composite Primary Key)
Current schema uses `key TEXT PRIMARY KEY` — meaning the same key name cannot exist
in two different folders. Folder isolation is currently an illusion.

```sql
-- BEFORE
CREATE TABLE secrets (
  key         TEXT PRIMARY KEY,
  folder      TEXT NOT NULL DEFAULT 'Root',
  ...
);

-- AFTER
CREATE TABLE secrets (
  key         TEXT NOT NULL,
  folder      TEXT NOT NULL DEFAULT 'Root',
  nonce       BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (folder, key)    -- composite PK enables true folder isolation
);
```
> This is a breaking migration — existing data must be migrated carefully.

### Network / Middleware Isolation

**Public endpoint** (`GET /api/secrets/:folder/:key`):
- Reachable from the internet via reverse proxy
- Has its own dedicated rate limiter instance (separate bucket + config)
- Rate limit env var: `SECRET_MANAGER_PUBLIC_RATE_LIMIT_PER_MINUTE`
- Requires valid read token

**All other endpoints** (internal only):
- Blocked at reverse proxy level (not just auth-level)
- Express additionally checks a trusted internal header or bind address as defense-in-depth
- Includes: `/api/tokens`, `/api/secrets` POST/DELETE, `/api/audit-logs`, `/api/exports`, `/api/folders/rename`

### X-Forwarded-For Fix (Related)
Current `getClientIp()` blindly trusts `X-Forwarded-For` — spoofable, bypasses rate limiting.

Fix: only trust `X-Forwarded-For` from known proxy IPs (configured via env var).
Otherwise fall back to `req.socket.remoteAddress` directly.

```
SECRET_MANAGER_TRUSTED_PROXY_IPS=127.0.0.1,::1
```

### Open Questions Resolved
- Public route supports `read` role tokens only (write tokens work but are unnecessary)
- Backward-compat with flat `GET /api/secrets/:key` — NOT required, clean break
- Rate limit for public endpoint — separate config, default TBD

---

## [PROPOSAL-003] Export Endpoint Redesign

**Status:** Discussed, pending implementation
**Priority:** High

### Problem
Current export endpoint:
```
GET /api/secrets/export
```
- Lives under `/api/secrets/*` prefix — dangerously close to the public-facing route
- Accessible to read tokens — a leaked CI read token can dump ALL secrets at once
- Naming makes it easy to accidentally expose via misconfigured proxy rules

### Proposed Change

**Before:**
```
GET /api/secrets/export     — accessible to read tokens, under public prefix
```

**After:**
```
GET /api/exports            — new dedicated path, clearly internal
```

#### Why a New Path
- Moves export completely out of the `/api/secrets/*` namespace
- Proxy rules become simpler and less error-prone: expose ONLY `/api/secrets/:folder/:key`, block everything else including `/api/exports`
- Cleaner semantic separation: `/api/secrets/*` = per-secret operations, `/api/exports` = bulk admin operation

#### Access Control Change
- Requires **write token** only (upgraded from read + write)
- Rationale: bulk export of all plaintext secrets is an admin operation, not a read operation
- A compromised CI read token should NEVER be able to exfiltrate everything

#### Audit Logging
- Export action already logged — no change needed, just update the action label to reflect new endpoint

---

## [PROPOSAL-004] VPS Hardening & Reliability Fixes

**Status:** Discussed, pending implementation
**Priority:** Blocking (do before going live) + High (do before first pipeline)

### Context
Service runs 24/7 on a public VPS. GitHub Actions pipelines depend on it — downtime
means broken CI across all projects.

### Fix List (Ordered by Priority)

#### BLOCKING — Before Going Live

**1. Remove hardcoded credentials from `docker-compose.yml`**
- Current: `SECRET_MANAGER_MASTER_KEY: "keY-ro01t"`, `ADMIN_TOKEN: "admin"` hardcoded
- Fix: Use `env_file: .env` in docker-compose, add `.env` to `.gitignore`, provide `.env.example`
- Effort: 10 min

**2. PBKDF2 for master key derivation**
- Current: `SHA256(masterKey)` — fast, brute-forceable if DB leaks
- Fix: `PBKDF2(masterKey, static-salt, 210000, 32, 'sha256')` — same as token hashing
- Effort: 30 min
- Note: one-time migration needed — re-encrypt all secrets with new derived key

**3. Composite PK schema migration**
- Prerequisite for PROPOSAL-002 folder-scoped fetch
- Effort: 2 hours (migration + all query updates)

**4. Fix X-Forwarded-For IP trust**
- Current: blindly trusts any `X-Forwarded-For` header — rate limit bypassable
- Fix: trust only from known proxy IPs via `SECRET_MANAGER_TRUSTED_PROXY_IPS` env var
- Effort: 20 min

**5. HTTPS enforcement**
- Reverse proxy (Nginx/Caddy) must redirect HTTP → HTTPS
- Express adds `Strict-Transport-Security` header
- Verify no path exposes plain HTTP on port 8000 externally
- Effort: 30 min

#### BEFORE FIRST PIPELINE GOES LIVE

**6. Transactions on import + folder rename**
- Current: partial import on crash = silent data corruption, no rollback
- Fix: wrap multi-row operations in `BEGIN/COMMIT/ROLLBACK`
- Effort: 1 hour

**7. Graceful shutdown handler**
- Current: SIGTERM kills process mid-request → dropped GitHub Actions fetch = failed CI job
- Fix: SIGTERM handler drains in-flight requests before exit
- Effort: 15 min

**8. Rate limiter memory leak fix (TTL eviction)**
- Current: IP buckets never evicted from Map — 24/7 public server will bloat over time
- Fix: periodic cleanup of buckets older than window duration
- Effort: 30 min

**9. Docker health check + uptime monitoring**
- Current: no health check in docker-compose — container appears healthy when DB is broken
- Fix: add `healthcheck` to docker-compose using `/healthz` endpoint
- Hook up to UptimeRobot (free) or similar — alert before pipelines tell you it's down
- Effort: 20 min

**10. Audit log retention / pruning policy**
- GitHub Actions can hit the endpoint hundreds of times/day — logs grow fast
- Fix: configurable max rows or time-based pruning (e.g. keep last 90 days)
- Env var: `SECRET_MANAGER_AUDIT_LOG_RETENTION_DAYS=90`
- Effort: 45 min

#### QUALITY OF LIFE — Do Soon After

**11. Secret versioning (keep last N values)**
- Rotating a wrong secret during an active pipeline run breaks CI with no recovery
- Fix: keep last 2-3 versions per secret, allow point-in-time restore
- Effort: 3 hours

**12. Folder list sourced from DB**
- Current: folder names stored in browser localStorage — inconsistent across devices
- Fix: derive folder list from `SELECT DISTINCT folder FROM secrets` at the DB level
- Effort: 1 hour

---

## Summary: Full Route Map (Post All Proposals)

### Public (internet-facing via reverse proxy)
| Method | Endpoint | Auth | Rate Limited |
|---|---|---|---|
| `GET` | `/api/secrets/:folder/:key` | read token | Yes (dedicated limiter) |
| `GET` | `/healthz` | None | No |

### Internal Only (blocked at proxy, VPS-local access only)
| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/secrets` | read | List all secret keys |
| `POST` | `/api/secrets` | write | Create / update secret |
| `DELETE` | `/api/secrets/:folder/:key` | write | Delete secret |
| `POST` | `/api/folders/rename` | write | Rename folder |
| `GET` | `/api/exports` | write | Bulk export all secrets |
| `POST` | `/api/secrets/import` | write | Bulk import from .env |
| `GET` | `/api/tokens` | write | List tokens |
| `POST` | `/api/tokens` | write | Create token |
| `DELETE` | `/api/tokens/:name` | write | Revoke token |
| `POST` | `/api/tokens/:name/rotate` | write | Rotate token |
| `GET` | `/api/auth/me` | read | Token info |
| `GET` | `/api/audit-logs` | read | Query audit logs |
| `GET` | `/secret-manager/*` | None | Serve frontend UI |

---
