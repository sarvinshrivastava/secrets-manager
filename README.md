# Secret Manager

Lightweight self-hosted environment variable (secrets) manager for hobby/small internal use.

- Backend: Express.js
- Frontend: Vite + React
- Storage: SQLite (WAL mode)
- Encryption at rest: AES-256-GCM (key derived from a master key via PBKDF2-SHA256)
- Auth: Bearer token or `X-API-Key`, token hashes stored in DB (PBKDF2-SHA256 + per-token salt)

## Folder Structure

```text
.
├── server
│   ├── package.json
│   └── src
│       ├── app.js              # Express app + route wiring
│       ├── index.js            # bootstrap, migrations, server start, graceful shutdown
│       ├── config.js           # env/.env settings loader
│       ├── crypto.js           # AES-256-GCM + PBKDF2 token hashing
│       ├── database.js         # SQLite (better-sqlite3) data layer
│       ├── rate-limit.js       # per-IP token-bucket limiter
│       ├── utils.js            # helpers (client IP, env-key validation, .env parse)
│       ├── middleware
│       │   ├── auth.js         # requireAuth, requireWriteAccess, writeAudit
│       │   └── security.js     # security headers + global rate limit
│       └── routes
│           ├── secrets.js      # /api/secrets*
│           ├── tokens.js       # /api/tokens*
│           ├── folders.js      # /api/folders*
│           ├── exports.js      # /api/exports
│           ├── import.js       # /api/import
│           └── audit.js        # /api/audit-logs
├── frontend
│   ├── package.json
│   ├── vite.config.js
│   └── src
│       ├── App.jsx
│       ├── main.jsx
│       └── styles.css
├── scripts
│   └── backup.sh               # WAL-safe hot backup + rotation
├── data/                       # secrets.db lives here (bind-mounted into Docker)
├── .github/workflows/deploy.yml # manual-dispatch VPS deploy (health gate + auto-rollback)
├── .env.example
├── .dockerignore
├── docker-compose.yml
├── Dockerfile
├── README.md
├── RUNBOOK.md                  # operations: backup/restore, key rotation, disk-full
└── PROPOSALS.md
```

## Concepts

### Folders

Every secret lives in a **folder**. The primary key is the composite `(folder, key)`,
so the same key name can exist in different folders (e.g. `DATABASE_URL` in both
`ServiceA` and `ServiceB`). Secrets created without a folder default to `Root`.
The public fetch route is folder-scoped: `GET /api/secrets/:folder/:key`.

### Tokens, roles, and scope

- **Roles:** `read` and `write`. Write implies read.
- **Bootstrap tokens** come from env (`SECRET_MANAGER_ADMIN_TOKEN` → `admin`/write,
  `SECRET_MANAGER_READ_TOKEN` → `reader`/read) and are re-upserted on every startup.
- **Runtime tokens** are created/revoked/rotated via `/api/tokens*` without a
  restart. Raw token value is shown exactly once at creation.
- **Per-folder scope:** a token carries a `scope` — either `*` (all folders) or a
  list of folders it may read. This limits blast radius: a token scoped to
  `ServiceA` cannot read `ServiceB`'s secrets or the `Infra` folder. Bootstrap
  tokens are `*`-scoped. A request for a folder outside the token's scope is
  rejected with `403 {"detail":"Token not scoped for folder 'X'"}`.

### Admin capability

Token/folder management is gated on scope, not just role:

- Only a **`*`-scoped write token** is an admin — it may manage other tokens
  (create / rotate / revoke), rename folders, and **read the audit log**
  (`GET /api/audit-logs`). A folder-scoped write token can read/write secrets in
  its folders but cannot administer tokens or folders, and cannot read the audit
  log — those entries expose key names, token names, and client IPs from **every**
  folder, so a scoped token reading them would escape its own scope.
- A token may only **grant a scope that is a subset of its own**. A token scoped
  to `["ServiceA","ServiceB"]` can mint a token scoped to `["ServiceA"]`, never a
  `*`-scoped or broader-scoped one. Only a `*`-scoped admin can mint another
  `*`-scoped token.
- `POST /api/tokens/:name/rotate` always returns a fresh **server-generated
  random** token value — there is no caller-supplied value.

## Configuration

Required:

- `SECRET_MANAGER_MASTER_KEY` — long random secret; the AES key is derived from it
  via PBKDF2-SHA256. **Rotating this strands existing secrets** (see RUNBOOK.md §5).

Recommended bootstrap tokens:

- `SECRET_MANAGER_ADMIN_TOKEN` — write token (bootstrapped as `admin`)
- `SECRET_MANAGER_READ_TOKEN` — read-only token (bootstrapped as `reader`)

Optional (defaults shown):

- `SECRET_MANAGER_DB_PATH` (`data/secrets.db`)
- `SECRET_MANAGER_RATE_LIMIT_PER_MINUTE` (`120`) — global per-IP limit on `/api/*`
- `SECRET_MANAGER_PUBLIC_RATE_LIMIT_PER_MINUTE` (`60`) — dedicated per-IP limit on
  the public `GET /api/secrets/:folder/:key` endpoint
- `SECRET_MANAGER_TRUSTED_PROXY_IPS` (`127.0.0.1,::1`) — comma-separated proxy IPs
  whose `X-Forwarded-For` is trusted for client-IP resolution; from any other
  source the header is ignored and `req.socket.remoteAddress` is used (prevents
  rate-limit spoofing)
- `SECRET_MANAGER_AUDIT_LOG_RETENTION_DAYS` (`90`) — audit rows older than this are
  pruned on startup and once a day
- `SECRET_MANAGER_HOST` (`0.0.0.0`)
- `SECRET_MANAGER_PORT` (`8000`)

## Run Locally

Install deps:

```bash
cd server && npm install
cd ../frontend && npm install
```

Create local env file:

```bash
cp .env.example .env
```

Update `.env` with a real `SECRET_MANAGER_MASTER_KEY` and tokens.

Start backend:

```bash
cd server
npm run dev
```

Start frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open UI: `http://localhost:5173/`

## Docker

```bash
docker compose up --build -d
```

Open UI: `http://localhost:8000/` (the container binds to
`127.0.0.1:8000` — for a real deployment reach it through the reverse proxy, not
this port directly). See RUNBOOK.md for VPS deployment specifics.

`./data` is **bind-mounted** into the container, because the production host's
live `data/secrets.db` is the real database. On a fresh box create it writable by
uid 1000 (`mkdir -p data && chown 1000:1000 data`) before the first `up`, or the
container crash-loops on `SQLITE_CANTOPEN`.

## Deploying

Deploys are **manual only**: run the **Deploy to VPS** workflow
(`.github/workflows/deploy.yml`) from the repo's **Actions** tab, optionally
choosing a `ref` (default `main`). It backs up the SQLite DB (fail-closed),
checks out the ref on the VPS, rebuilds, then gates on `/healthz` plus a
`GET /api/folders` version fingerprint — and **rolls back automatically** if
either gate fails. Prerequisites and the full procedure are in
[RUNBOOK.md §9 “Deploying”](RUNBOOK.md).

## API Endpoints

All `/api/*` routes require auth unless noted:

- `Authorization: Bearer <token>`, or
- `X-API-Key: <token>`

Errors are JSON: `{ "detail": "..." }`. Rate-limited requests get `429`.

### Public (safe to expose through the reverse proxy)

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/healthz` | none | `{"status":"ok"}` |
| `GET` | `/api/secrets/:folder/:key` | read | Decrypted value; dedicated per-IP rate limiter |

```bash
# Fetch one secret by folder + key (the CI-facing route)
curl -s -H "Authorization: Bearer <READ_TOKEN>" \
  http://localhost:8000/api/secrets/Root/DATABASE_URL
# -> {"key":"DATABASE_URL","value":"...","folder":"Root","created_at":"..."}
```

### Internal only (block these at the reverse proxy)

**Secrets**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/secrets` | read | List all `{folder, key}` pairs — no values |
| `POST` | `/api/secrets` | write | Create secret; never overwrites — `409` if it already exists |
| `POST` | `/api/secrets/bulk` | write | Bulk create in one folder (see below) |
| `PATCH` | `/api/secrets/:folder/:key` | write | Rename, move and/or replace the value (see below) |
| `DELETE` | `/api/secrets/:folder/:key` | write | Delete one secret |

```bash
# Create (never overwrites; use PATCH below to change a secret)
curl -s -X POST http://localhost:8000/api/secrets \
  -H "Authorization: Bearer <WRITE_TOKEN>" -H "Content-Type: application/json" \
  -d '{"key":"DATABASE_URL","value":"postgres://...","folder":"Root"}'

# Edit: any of key / folder / value (at least one; every field must be a string)
curl -s -X PATCH http://localhost:8000/api/secrets/Root/DATABASE_URL \
  -H "Authorization: Bearer <WRITE_TOKEN>" -H "Content-Type: application/json" \
  -d '{"key":"DB_URL","folder":"ServiceA","value":"postgres://..."}'

# Delete
curl -s -X DELETE -H "Authorization: Bearer <WRITE_TOKEN>" \
  http://localhost:8000/api/secrets/Root/DATABASE_URL
```

`PATCH` keeps the secret's id and `created_at`. A present `folder` must be
non-empty (no `Root` fallback). The token needs scope for both the source and
the target folder. Responses: `200 {"status":"ok","key","folder"}`, `400`
(invalid or no field), `403` (read token or out-of-scope folder), `404`
(source missing), `409` (target already exists). An edit that changes nothing
(same key and folder, no `value`) returns `200` with no write and no audit row.
Each real edit writes a `secret_edited` audit row with
`from=<folder>|<key> to=<folder>|<key> value_changed=<bool>`; the value is never
logged. Renaming or moving breaks anything that still `GET`s the old path.

Key names must be environment-style: letters, digits, underscores, not starting
with a digit. `folder` defaults to `Root` when omitted.

**Bulk create** — `POST /api/secrets/bulk` (write):

```jsonc
// request body
{
  "folder": "ServiceA",
  "secrets": [ { "key": "API_KEY", "value": "abc" }, { "key": "DB_URL", "value": "..." } ],
  "overwrite": ["API_KEY"]        // keys allowed to replace an existing secret
}
// response (HTTP 207)
{
  "added":   ["DB_URL"],
  "updated": ["API_KEY"],
  "skipped": ["EXISTING_KEY"],
  "invalid": [ { "key": "1BAD", "reason": "invalid key" } ],
  "folder":  "ServiceA"
}
```
Keys not listed in `overwrite` are skipped if they already exist (reported in
`skipped`); keys in `overwrite` that exist are replaced (reported in `updated`);
malformed keys/values are reported in `invalid` as `{ key, reason }` objects.

**Folders**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/folders` | read | List distinct folders (derived from the DB) |
| `POST` | `/api/folders/rename` | write | `{ "from": "...", "to": "..." }` → moves all secrets |

**Tokens** — write role required, and managing tokens (create/rotate/revoke) or
renaming folders requires a **`*`-scoped** (admin) token. A token may only grant
a `scope` that is a subset of its own.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/tokens` | List tokens (name, role, timestamps, `expires_at`, `revoked_at`) — never raw values |
| `POST` | `/api/tokens` | Create: `{ "name", "role":"read\|write", "scope"?, "expires_in_seconds"? }` → returns `token` once (`201`). `scope` must be a subset of the caller's scope |
| `DELETE` | `/api/tokens/:name` | Revoke (tombstone). Refuses to revoke the last active write token |
| `POST` | `/api/tokens/:name/rotate` | Rotate to a new **server-generated random** value — returned once. No caller-supplied value accepted |

**Bulk export / import**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/exports` | **write** | Dump all secrets as `.env` text (`text/plain`). Write-only on purpose — a leaked read token must not exfiltrate everything |
| `POST` | `/api/import` | write | Body is `text/plain` `.env` content; all-or-nothing transaction → `{ "imported", "skipped" }` |

```bash
# Export everything as .env (WRITE token)
curl -s -H "Authorization: Bearer <WRITE_TOKEN>" http://localhost:8000/api/exports

# Import .env content (WRITE token) — existing keys are skipped, not overwritten
curl -s -X POST http://localhost:8000/api/import \
  -H "Authorization: Bearer <WRITE_TOKEN>" -H "Content-Type: text/plain" \
  --data-binary @/path/to/import.env
```

**Identity & audit**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/auth/me` | read | `{ "token_name", "role" }` for the presented token |
| `GET` | `/api/audit-logs` | **admin** (`*`-scoped write) | Query params: `action`, `status`, `key`, `token_name`, `limit` (1–500, default 100). A folder-scoped token gets `403 {"detail":"Admin token required"}` — the log spans all folders |
| `GET` | `/api/analytics` | read (any role) | Usage analytics, see below |

**Analytics** — `GET /api/analytics?range=24h|7d|30d|90d` (default `7d`; an empty, repeated or unknown `range` is `400 {"detail":"Invalid range"}`). The endpoint writes no audit row of its own.

- Admin (write role and scope `*`, the same test as `/api/audit-logs`) gets every panel. Anyone else gets `secrets` (only the folders their scope allows) and `null` for `tokens`, `activity`, `top_keys`, `top_tokens` and `unread`. A non-admin is not audited and not refused.
- Response: `range`, `since`, `generated_at`, `retention_days`, `clamped`, `admin`, `secrets {total, folders[{folder,count}]}`, `tokens {active, expiring_7d, expired, revoked_all_time}`, `activity {bucket:"hour"|"day", points[{t, reads, secret_writes, auth_failures, rate_limited}]}`, `top_keys[{key,reads}]` (max 10), `top_tokens[{name,events}]` (max 10), `unread {total, items[{folder,key,created_at}]}` (items max 50). Lists are `[]`, never `null`.
- Time model (UTC): `24h` is 24 hour buckets, the others 7, 30 or 90 day buckets, ending in the current bucket and zero-filled. Rows count when `since <= timestamp <= generated_at`. `since` is the window start, moved later when the audit retention (`AUDIT_LOG_RETENTION_DAYS`) is shorter than the range; then `clamped` is `true`.
- `reads`: ok `get_secret` and ok `export_env` (`list_keys` is not a read). `top_keys` counts ok `get_secret` only, grouped by key name across folders. `secret_writes`: ok `secret_created`, `secret_updated`, `secret_edited`, `secret_deleted`, and one per `import_env`. `auth_failures`: `auth` and `authz` rows (folder-scope denials are not audited, so not counted). `rate_limited`: `rate_limit` rows. These count logged audit rows. `top_tokens` counts every audit row carrying the token name.
- `tokens`: `active` is not revoked and not expired; `expiring_7d` is active and expires within 7 days; `revoked_all_time` is not limited to the window.
- `unread` ("Not read in window") is a hint, never a delete list. It lists secrets created before `since` with no read evidence in the window: an ok `get_secret` (rows logged before this version match by key name only), an ok `export_env` naming the folder (legacy rows without the folder list cover every folder), an ok `secret_edited` whose target is the secret (a value-only edit counts, a bulk overwrite does not), or an ok `folder_renamed` into its folder (this also marks the existing secrets of a non-empty target folder).
- Audit details used above: `get_secret` rows carry `folder=<F>` (`folder=<F> Decrypt failure` on error) and `export_env` rows carry `folders=<F1>,<F2>`, sorted by code point.
- A `(timestamp, action)` index on `audit_logs` is created at start-up. Each aggregate is one range scan bounded by the audit retention.

## Security Notes

- Secret values are encrypted with AES-256-GCM before DB storage; the key is
  PBKDF2-SHA256-derived from the master key.
- API tokens are stored hashed (PBKDF2-SHA256) with per-token random salt and
  verified with `timingSafeEqual`.
- Never logs plaintext secret values. Audit table tracks action, key name,
  status, token name, and source IP.
- Per-IP rate limiting: a global limiter on all `/api/*` plus a dedicated limiter
  on the public fetch route.
- `X-Forwarded-For` is trusted only from `SECRET_MANAGER_TRUSTED_PROXY_IPS`.
- Sends `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`. Intended for deployment behind an HTTPS reverse proxy that
  exposes ONLY the public routes.
- Rotate tokens via `/api/tokens*` (runtime) or by changing env bootstrap tokens
  and restarting.
- Rotating the master key invalidates decryption of existing secrets unless they
  are re-exported and re-imported first (RUNBOOK.md §5).

## Notes

- This project is intentionally minimal and not enterprise multi-tenant.
- For production hardening see RUNBOOK.md (backups, restore drills, monitoring)
  and PROPOSALS.md (design decisions).
