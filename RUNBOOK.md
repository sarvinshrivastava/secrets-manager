# Secret Manager — Operations Runbook

Operational procedures for the Secret Manager running 24/7 on a public VPS behind
a TLS reverse proxy. This DB is the single source of truth for CI secrets and
token hashes across every consuming repo — treat outages and data loss as
production incidents.

- **Container:** `secret-manager` (docker compose, `restart: unless-stopped`)
- **Data:** named volume `secret-manager-data` mounted at `/app/data`
- **DB file:** `/app/data/secrets.db` (SQLite, WAL mode)
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

> The compose file uses a **named volume**, so there is no `./data` ownership
> step to do. If you deliberately switch to a bind mount (`./data:/app/data`),
> you MUST pre-create it writable by uid 1000 first, or the container
> crash-loops on `SQLITE_CANTOPEN`:
> ```bash
> mkdir -p data && sudo chown 1000:1000 data
> ```

---

## 2. Backups

- **Script:** `scripts/backup.sh` — WAL-safe hot snapshot via `sqlite3 ".backup"`
  (never `cp`), timestamped output, `PRAGMA integrity_check` on every snapshot,
  keep-last-N rotation.
- **Schedule:** daily via cron. Example (adjust paths):
  ```cron
  15 3 * * * DB_PATH=/opt/secret-manager/data/secrets.db BACKUP_DIR=/var/backups/secret-manager KEEP=14 /opt/secret-manager/scripts/backup.sh >> /var/log/secret-manager-backup.log 2>&1
  ```
- **Reaching the DB inside the named volume from the host:** either resolve the
  volume mountpoint
  (`docker volume inspect secret-manager-data -f '{{.Mountpoint}}'`) and point
  `DB_PATH` at `<mountpoint>/secrets.db`, or run the backup inside the container
  (`docker compose exec secret-manager sh -c 'sqlite3 /app/data/secrets.db ".backup /app/data/backup.db"'`)
  and copy it out with `docker cp`.
- **OFF-SITE IS MANDATORY.** A backup on the same disk dies with the VPS. Ship
  each snapshot to object storage or another host. Value-level ciphertext is
  still decryptable by anyone who also holds `SECRET_MANAGER_MASTER_KEY`, so keep
  backups in a private, access-restricted location and NEVER store the master
  key alongside them.

---

## 3. Restore drill (practice this before you need it)

```bash
# 1. Stop the service so nothing writes mid-restore.
docker compose stop secret-manager

# 2. Verify the backup you intend to restore is sound.
sqlite3 /path/to/secrets-<TS>.db 'PRAGMA integrity_check;'   # must print: ok

# 3. Replace the live DB (inside the named volume). Remove stale WAL/SHM
#    sidecars so the engine doesn't replay an old WAL over the restored file.
VOL=$(docker volume inspect secret-manager-data -f '{{.Mountpoint}}')
sudo rm -f "$VOL"/secrets.db "$VOL"/secrets.db-wal "$VOL"/secrets.db-shm
sudo cp /path/to/secrets-<TS>.db "$VOL"/secrets.db
sudo chown 1000:1000 "$VOL"/secrets.db     # must be owned by the node user (uid 1000)

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
(see §5).

---

## 4. Integrity check

Run any time you suspect corruption (unclean shutdown, disk errors):
```bash
docker compose exec secret-manager node -e "1"   # container alive?
sqlite3 <db> 'PRAGMA integrity_check;'            # ok = healthy
sqlite3 <db> 'PRAGMA wal_checkpoint(TRUNCATE);'   # optional: fold WAL into main
```
If `integrity_check` reports anything other than `ok`, stop the service and
restore from the most recent good backup (§3).

---

## 5. Master-key rotation caveat

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
   **empty** DB (fresh volume).
3. Re-import via `POST /api/import`.
4. Destroy the plaintext export immediately afterward.

Token hashes are independent of the master key and survive rotation.

---

## 6. Lost / leaked admin (write) token recovery

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

## 7. Disk-full response

Symptoms: writes fail with `SQLITE_FULL` / `disk I/O error`, container may keep
restarting, health check flaps.

1. Check space: `df -h` and, for the volume,
   `du -sh $(docker volume inspect secret-manager-data -f '{{.Mountpoint}}')`.
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
