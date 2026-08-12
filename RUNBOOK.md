# Secret Manager — Operations Runbook

Operational procedures for the Secret Manager running 24/7 on a public VPS behind
a TLS reverse proxy. This DB is the single source of truth for CI secrets and
token hashes across every consuming repo — treat outages and data loss as
production incidents.

- **Container:** `secret-manager` (docker compose, `restart: unless-stopped`)
- **Data:** host **bind mount** `./data` → `/app/data` (i.e. the live DB is a
  normal file on the host at `<app dir>/data/secrets.db`, reachable without
  Docker). Deploying with a named volume instead would start the app against an
  empty DB — see the comment in `docker-compose.yml`.
- **DB file:** `/app/data/secrets.db` in-container = `/root/secrets-manager/data/secrets.db` on the host (SQLite, WAL mode)
- **Listen:** `127.0.0.1:8000` only — public access is via the host reverse proxy
- **Health:** `GET /healthz` → `{"status":"ok"}` (no auth)

---

## 1. First-time deploy / fresh clone

1. Create `.env` from the template and fill in real values:
   ```bash
   cp .env.example .env
   # set a long random SECRET_MANAGER_MASTER_KEY and the bootstrap tokens
   ```
2. Bring it up:
   ```bash
   docker compose up --build -d
   docker compose ps          # STATUS should reach "healthy" within ~15-45s
   docker compose logs -f      # look for "Secret Manager listening on 0.0.0.0:8000"
   ```
3. Point the reverse proxy at `127.0.0.1:8000`, terminate TLS, and expose ONLY
   `GET /api/secrets/:folder/:key` and `/healthz` to the internet. Block every
   other `/api/*` path at the proxy (see PROPOSALS.md route map).

> **DANGER — do NOT publicly proxy the admin UI.** The SPA now serves at `/`
> (it used to live under `/secret-manager/`). A careless reverse-proxy catch-all
> — `location / { proxy_pass http://127.0.0.1:8000; }` — re-exposes the entire
> internal API (`/api/tokens`, `/api/exports`, `/api/import`, `/api/secrets`
> list, `/api/folders`, `/api/audit-logs`) straight to the internet, defeating
> the whole point of the route allowlist. Rules:
> - The public vhost must proxy ONLY `GET /api/secrets/:folder/:key` and
>   `/healthz`. Use explicit `location` matches for those two paths — never a
>   bare catch-all `location /`.
> - Reach the admin UI at `/` via an **SSH tunnel** to `127.0.0.1:8000`
>   (`ssh -L 8000:127.0.0.1:8000 <host>`, then open `http://localhost:8000/`),
>   NOT through the public proxy.
> - If you must serve the UI over HTTP, put it on a **separate,
>   independently-authenticated, path-scoped vhost** (e.g. its own hostname
>   behind Basic-Auth / mTLS / an allowlisted source IP) that likewise does not
>   use a bare catch-all `location /`.

> The compose file uses a **bind mount** (`./data:/app/data`) so the container
> keeps reading the host's existing database. A bind-mounted directory is created
> root-owned, and the image runs as `USER node` (uid 1000), so on a fresh box you
> MUST pre-create it writable by uid 1000 or the container crash-loops on
> `SQLITE_CANTOPEN`:
> ```bash
> mkdir -p data && sudo chown 1000:1000 data
> ```
> Do **not** "fix" that by switching to a named volume: the app would then start
> against an empty DB while the real secrets sit untouched in `./data`, and every
> consuming CI pipeline would break.

---

## 2. Container crash-looping / won't start

**Symptom:** `docker compose ps` shows the `secret-manager` container as
`Restarting` (or it never reaches `healthy` and keeps bouncing).

**Diagnose — read the boot logs first:**
```bash
docker compose logs --tail=50 secret-manager
```
Look for one of these fatal signatures near the end of the log:

| Log signature | Cause | Remedy |
|---|---|---|
| `FATAL: all N stored secret(s) failed to decrypt` (from `index.js`) | Wrong `SECRET_MANAGER_MASTER_KEY` — the key doesn't match the one the DB was encrypted with (typo, unset, or rotated key over an old DB). The app hard-exits rather than serve a DB it can't decrypt. | Restore the correct `SECRET_MANAGER_MASTER_KEY` in `.env` and restart. If the key is truly lost, the values are unrecoverable — restore a DB + key pair that match (see §4), or start fresh (see §6). |
| `FATAL: SECRET_MANAGER_ADMIN_TOKEN contains a '.'` (also possible for `SECRET_MANAGER_READ_TOKEN`; from `assertBootstrapTokenFormat` in `utils.js`) | The bootstrap token value contains a `.`, which is reserved as the separator in the `<name>.<secret>` wire format. A dotted token is parsed as a *named* token and can therefore never authenticate — it would silently brick the vault, so the app refuses to boot instead. | Set a **dotless** bootstrap token in `.env` (e.g. `openssl rand -hex 32`, which is hex and cannot contain a `.`) and redeploy. Note this changes the `admin`/`reader` token value: update any consumer holding the old one (see §7). |
| `Error: ...` on startup about zero write tokens / `db.countWriteTokens() === 0` | No usable write token — the server refuses to boot without at least one active write path (bootstrap env token missing AND no runtime write token in the DB). | Set `SECRET_MANAGER_ADMIN_TOKEN` (bootstrap write token) in `.env` and `docker compose up -d` — it's re-upserted on startup (see §7). If the DB itself is the problem, restore from backup (§4). |

After fixing the cause, `docker compose up -d` and confirm
`docker compose ps` reaches `healthy`.

> **Unhealthy ≠ restarting.** A container that stays `Up (unhealthy)` (e.g. a
> broken DB handle returning `/healthz` 503) does NOT exit, so
> `restart: unless-stopped` never fires. The `autoheal` sidecar (see
> `docker-compose.yml`) handles that case by restarting unhealthy containers.
> Regardless, run **external uptime monitoring that polls `GET /healthz` and
> alerts** on non-200 — a 503 on its own does not page anyone, and without the
> autoheal sidecar it never auto-recovers.

---

## 3. Backups

- **Script:** `scripts/backup.sh` — WAL-safe hot snapshot via `sqlite3 ".backup"`
  (never `cp`), timestamped output, `PRAGMA integrity_check` on every snapshot,
  keep-last-N rotation.
- **Schedule:** daily via cron. Example (adjust paths):
  ```cron
  15 3 * * * DB_PATH=/root/secrets-manager/data/secrets.db BACKUP_DIR=/var/backups/secret-manager KEEP=14 /root/secrets-manager/scripts/backup.sh >> /var/log/secret-manager-backup.log 2>&1
  ```
- **Reaching the DB from the host:** it is a plain bind-mounted file — point
  `DB_PATH` straight at `<app dir>/data/secrets.db` (on the VPS:
  `/root/secrets-manager/data/secrets.db`). No volume-mountpoint lookup and
  no `docker cp` dance needed. `sqlite3 ".backup"` is safe while the container
  runs.
- **`sqlite3` must be installed on the host** (`apt-get install -y sqlite3`) —
  the deploy workflow's pre-deploy backup is fail-closed and aborts the deploy
  without it.
- **OFF-SITE IS MANDATORY.** A backup on the same disk dies with the VPS. Ship
  each snapshot to object storage or another host. Value-level ciphertext is
  still decryptable by anyone who also holds `SECRET_MANAGER_MASTER_KEY`, so keep
  backups in a private, access-restricted location and NEVER store the master
  key alongside them.

---

## 4. Restore drill (practice this before you need it)

```bash
# 1. Stop the service so nothing writes mid-restore.
docker compose stop secret-manager

# 2. Verify the backup you intend to restore is sound.
sqlite3 /path/to/secrets-<TS>.db 'PRAGMA integrity_check;'   # must print: ok

# 3. Replace the live DB (the bind-mounted host file). Remove stale WAL/SHM
#    sidecars so the engine doesn't replay an old WAL over the restored file.
DATA=/root/secrets-manager/data        # the bind-mount source on the host
sudo rm -f "$DATA"/secrets.db "$DATA"/secrets.db-wal "$DATA"/secrets.db-shm
sudo cp /path/to/secrets-<TS>.db "$DATA"/secrets.db
sudo chown 1000:1000 "$DATA"/secrets.db    # must be owned by the node user (uid 1000)

# 4. Start and verify.
docker compose start secret-manager
docker compose ps                          # -> healthy
curl -s http://127.0.0.1:8000/healthz      # -> {"status":"ok"}
# spot-check a known secret (read token):
curl -s -H "Authorization: Bearer <READ_TOKEN>" \
  http://127.0.0.1:8000/api/secrets/Root/SOME_KNOWN_KEY
```

**Restore only works with the SAME `SECRET_MANAGER_MASTER_KEY` that was in use
when the backup was taken** — the values are AES-256-GCM encrypted with a key
derived from it. Restoring an old DB under a new master key strands every secret
(see §6).

---

## 5. Integrity check

Run any time you suspect corruption (unclean shutdown, disk errors):
```bash
docker compose exec secret-manager node -e "1"   # container alive?
sqlite3 <db> 'PRAGMA integrity_check;'            # ok = healthy
sqlite3 <db> 'PRAGMA wal_checkpoint(TRUNCATE);'   # optional: fold WAL into main
```
If `integrity_check` reports anything other than `ok`, stop the service and
restore from the most recent good backup (§4).

---

## 6. Master-key rotation caveat

Secret values are encrypted with a key derived (PBKDF2-SHA256) from
`SECRET_MANAGER_MASTER_KEY`. **Rotating the master key does NOT re-encrypt
existing data** — the app can only auto-migrate the one specific legacy case it
knows about (old SHA256-derived → PBKDF2 on the *same* master string, handled on
startup in `index.js`). Changing the master string itself strands every existing
secret: decryption fails and those values are unrecoverable.

To rotate the master key safely:
1. `GET /api/exports` (write token) to dump all secrets as plaintext `.env`
   while the OLD key is still in place.
2. Stop the service, set the new `SECRET_MANAGER_MASTER_KEY`, and start with an
   **empty** DB (move `data/secrets.db` — plus its `-wal`/`-shm` sidecars —
   aside; keep them until the re-import is verified).
3. Re-import via `POST /api/import`.
4. Destroy the plaintext export immediately afterward.

Token hashes are independent of the master key and survive rotation.

---

## 7. Lost / leaked admin (write) token recovery

Bootstrap tokens are re-upserted from env on every startup (`index.js`): setting
`SECRET_MANAGER_ADMIN_TOKEN` / `SECRET_MANAGER_READ_TOKEN` and restarting
re-establishes the `admin` / `reader` tokens with the new values.

- **Lost the admin token:** put a fresh value in `.env`
  (`SECRET_MANAGER_ADMIN_TOKEN=...`) and `docker compose up -d` — the `admin`
  token is upserted to the new value.
- **Leaked a token:** revoke it via `DELETE /api/tokens/:name` (tombstoned, not
  deleted — audit trail preserved). Note the API refuses to revoke the **last
  active write token**; create a replacement write token first, then revoke.
- **Never rely on env bootstrap as the only write token** in steady state —
  create named runtime tokens (`POST /api/tokens`) so individual credentials can
  be revoked without touching the bootstrap env.
- The server refuses to start if `db.countWriteTokens() === 0` — always keep at
  least one valid write path.

---

## 8. Disk-full response

Symptoms: writes fail with `SQLITE_FULL` / `disk I/O error`, container may keep
restarting, health check flaps.

1. Check space: `df -h` and, for the data dir,
   `du -sh /root/secrets-manager/data`.
2. Common culprits and fixes:
   - **Docker container logs** — capped in compose (`max-size:10m,max-file:3`).
     If an older deploy wasn't capped: `docker system prune` and truncate
     `/var/lib/docker/containers/*/*-json.log`.
   - **Backups piling up** — lower `KEEP` in the cron job / prune
     `$BACKUP_DIR`.
   - **Audit log growth** — the DB self-prunes on startup and daily to
     `SECRET_MANAGER_AUDIT_LOG_RETENTION_DAYS` (default 90). Lower it and restart
     to shrink, then reclaim pages:
     `sqlite3 <db> 'VACUUM;'` (do this with the service stopped).
   - **WAL bloat** — `sqlite3 <db> 'PRAGMA wal_checkpoint(TRUNCATE);'`.
3. Reads (the public CI path) keep working as long as there's a sliver of space;
   prioritize freeing enough to let writes and the daily prune run.

---

## 9. Deploying

Deploys are **manual only** — there is no push-triggered deploy. This vault is
what every other repo's CI reads its secrets from, so a human decides when it
changes.

**How to deploy**

1. GitHub → **Actions** tab → **Deploy to VPS** → **Run workflow**.
2. Inputs:
   - `ref` — branch, tag, or full SHA to deploy (default `main`; a bare branch
     name is resolved against `origin`, so `main` → `origin/main`).
   - `skip_backup` — leave `false`. `true` is **emergency only**: it deploys with
     no fresh restore point.
3. Watch the run. A `concurrency` group serializes deploys, so a second run
   queues rather than racing the first.

**What the run does, in order**

1. SSHes to `${{ secrets.VPS_HOST }}` as `root`, `cd /root/secrets-manager`,
   and aborts unless that is a git repo.
2. Records the current SHA as the rollback target.
3. **Backs up the DB, fail-closed** via `scripts/backup.sh`
   (`sqlite3 ".backup"` + `integrity_check`, output in
   `/var/backups/secret-manager`, `KEEP=14`). If `sqlite3` is missing or the
   backup fails, the deploy **aborts before touching anything** — the running
   service is untouched. Install `sqlite3`, or re-run with `skip_backup=true` if
   you accept the risk.
4. `git fetch origin --prune` then `git checkout -f <ref>`. `.env` and `data/`
   are gitignored, so the master key, bootstrap tokens, and the live SQLite DB
   all survive the checkout.
5. `docker compose up --build -d`.

**What the health gate checks**

- **Liveness:** polls `http://127.0.0.1:8000/healthz` (loopback-only, hence
  on-box over SSH) for up to **90s**, expecting HTTP **200**.
- **Version fingerprint:** `GET http://127.0.0.1:8000/api/folders` must **not**
  return `404`. `/healthz` alone cannot prove the new code is live — the old
  release answers it identically. `/api/folders` exists only in this release, so
  an unauthenticated `401`/`403` is the expected pass; `404` means the old
  container is still serving.
- **Public reachability:** the `public_health_url` input (default
  `https://secrets.vps.sarvinshrivastava.space/healthz`) must return **200**
  from outside the box. The two checks above only prove the container is healthy
  *on loopback*. This release narrowed the published port from `0.0.0.0:8000` to
  `127.0.0.1:8000`, so if the host's reverse proxy forwards anywhere other than
  loopback, the endpoint every CI pipeline actually calls goes dark while both
  on-box gates stay green. Blank the input to skip this check.

**Rollback is automatic.** If the build or any gate fails, the run prints
`docker compose logs --tail=50`, checks out the previous SHA, rebuilds, re-polls
health, reports whether service was restored, and **exits non-zero** (red run).
If the rollback itself fails to come back healthy, the log says so explicitly —
that is a manual-intervention incident (check `.env`, disk space, and §4).

**One-time prerequisites**

- Repo secrets **`VPS_HOST`** and **`VPS_SSH_KEY`** (Settings → Secrets and
  variables → Actions). These come from GitHub secrets **on purpose, not from
  this vault**: the vault cannot bootstrap from itself, and if a bad deploy broke
  it, the rollback deploy would lose its own credentials exactly when it needs
  them. (Sibling repos that fetch VPS creds *from* this service must not be
  copied here.)
- **`sqlite3` installed on the host** — `apt-get install -y sqlite3`. Without it
  every deploy aborts at the backup step.
- **`curl` installed on the host** — the health gate uses it; the deploy aborts
  early if it's missing, before changing anything.
- **`data/` owned by uid 1000** — `chown 1000:1000 /root/secrets-manager/data`
  (bind mount + `USER node`; see §1).
- The checkout at `/root/secrets-manager` must already exist with its `.env`
  in place. The workflow updates an existing deployment; it does not clone.

### Reverse proxy — CHANGED in this release

This release **moved the admin UI from `/secret-manager/` to `/`**. Consequences
to handle at cutover:

- The **old UI path `/secret-manager/` now 404s.** Update bookmarks; if the proxy
  rewrites/strips that prefix, remove the rule.
- The public vhost must expose **only** `GET /api/secrets/:folder/:key` and
  `/healthz`, via explicit `location` matches. Because the SPA now sits at `/`, a
  bare catch-all `location / { proxy_pass ... }` would re-expose the whole
  internal API — `/api/tokens`, `/api/exports`, `/api/import`, `/api/secrets`
  list, `/api/folders`, `/api/audit-logs` — to the internet.
- Reach the UI at `/` through an **SSH tunnel**, not the public proxy:
  `ssh -L 8000:127.0.0.1:8000 <host>`, then open `http://localhost:8000/`.

See the DANGER block in §1 for the full rules.
