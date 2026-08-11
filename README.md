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
├── data/                       # secrets.db lives here (named volume in Docker)
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
  tokens are `*`-scoped.

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

Open UI: `http://localhost:5173/secret-manager/`

## Docker

```bash
docker compose up --build -d
```

Open UI: `http://localhost:8000/secret-manager/` (the container binds to
`127.0.0.1:8000` — for a real deployment reach it through the reverse proxy, not
this port directly). See RUNBOOK.md for VPS deployment specifics.

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
| `POST` | `/api/secrets` | write | Create secret; immutable — `409` if it already exists |
| `POST` | `/api/secrets/bulk` | write | Bulk create in one folder (see below) |
| `DELETE` | `/api/secrets/:folder/:key` | write | Delete one secret |

```bash
# Create (delete-then-recreate to change a value; create is immutable)
curl -s -X POST http://localhost:8000/api/secrets \
  -H "Authorization: Bearer <WRITE_TOKEN>" -H "Content-Type: application/json" \
  -d '{"key":"DATABASE_URL","value":"postgres://...","folder":"Root"}'

# Delete
curl -s -X DELETE -H "Authorization: Bearer <WRITE_TOKEN>" \
  http://localhost:8000/api/secrets/Root/DATABASE_URL
```

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
// response
{ "added": ["DB_URL"], "skipped": ["..."], "invalid": ["..."] }
```
Keys not listed in `overwrite` are skipped if they already exist; malformed keys
are reported in `invalid`.

**Folders**

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/folders` | read | List distinct folders (derived from the DB) |
| `POST` | `/api/folders/rename` | write | `{ "from": "...", "to": "..." }` → moves all secrets |

**Tokens** (write role required for all)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/tokens` | List tokens (name, role, timestamps, `expires_at`, `revoked_at`) — never raw values |
| `POST` | `/api/tokens` | Create: `{ "name", "role":"read\|write", "expires_in_seconds"? }` → returns `token` once (`201`) |
| `DELETE` | `/api/tokens/:name` | Revoke (tombstone). Refuses to revoke the last active write token |
| `POST` | `/api/tokens/:name/rotate` | New value for existing token; optional `{ "token": "<64+ hex>" }` to set a custom value |

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
| `GET` | `/api/audit-logs` | read | Query params: `action`, `status`, `key`, `token_name`, `limit` (1–500, default 100) |

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
