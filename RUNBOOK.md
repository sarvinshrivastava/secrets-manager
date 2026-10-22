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

There are three backup paths. They are independent: any one of them is enough to restore.

| Path | Where | When | Who can delete it |
|---|---|---|---|
| **In-process daily** (this service) | `backups/secrets-<slot>.db` on the VPS (bind mount `./backups` → `/app/backups`), 14 days | daily slot, default 22:30 UTC (04:00 IST) | the vault process (uid 1000) |
| **Off-site** (this service) | private GitHub repo `sarvinshrivastava/vault-backups`, release `daily`, one asset `secrets-<slot>.db.gz.age` per slot, age-encrypted | same run, after the local copy | the PAT in `.env` (Contents write) |
| **Host cron** (root) | `/var/backups/secret-manager/secrets-<ts>.db`, `KEEP=14` by count | daily 21:45 UTC until the off-site copy is proven, then monthly on the 1st (`/etc/cron.d/secret-manager-backup`); also the deploy workflow's pre-deploy backup (§9) | root only |

### In-process daily backup and off-site copy

- **Switch:** `SECRET_MANAGER_BACKUP_DIR=/app/backups` in `.env` turns it on; unset = off
  (no timer, no files, no egress). All keys are in `.env.example`. A typo in a backup key
  never stops the vault from booting: it is reported as a reason code (§3c) and paged.
- **Slot:** one per UTC day, named by its UTC date (`YYYYMMDD`), at
  `SECRET_MANAGER_BACKUP_UTC_TIME` (default `22:30`). The 22:30 UTC run of 20 Oct is slot
  `20261020` (04:00 IST on 21 Oct). Retries keep the slot name even after 00:00 UTC.
- **Boot catch-up:** 120 s after the container starts, the latest due slot runs again
  unless it is already done (a verified off-site asset, or, in local-only mode, the local
  file). A config error always runs it, so a bad redeploy pages within minutes.
- **Retries:** a failed attempt retries at +15 min and +30 min (3 attempts per slot).
  `config_invalid`, `private_key_on_vps`, `token_expiring` and `slot_asset_foreign` are not
  retried. A run has a 20 min deadline (`timeout`).
- **Order per slot** (a crash at any point leaves the less harmful state):
  1. Local snapshot: SQLite online backup on the app's own connection into
     `backups/.inflight.tmp` (0600) → `journal_mode=DELETE` → `integrity_check` → row
     counts → fsync → rename to `secrets-<slot>.db`. A verified file for the slot is reused.
  2. Local rotation: keep the last 14 days (`SECRET_MANAGER_BACKUP_KEEP_DAYS`) and always the
     newest 14 files; only `secrets-YYYYMMDD.db` names are touched.
  3. Off-site reconcile: if the slot's asset already exists and verifies, it is not
     uploaded again; a broken one (`starter` after a cut upload, a digest mismatch) is
     deleted; one without our `sha256-…` label is left alone (`slot_asset_foreign`).
  4. gzip + age encryption **in the process** to the public recipient
     (`SECRET_MANAGER_BACKUP_AGE_RECIPIENT`; the private key is never on the VPS), upload as
     a release asset with label `sha256-<hex>`, verify GitHub's `digest` against it (or
     download and hash it when GitHub has no digest yet).
  5. Remote retention, only after the slot is verified: keep the newest 30 slots plus the
     oldest slot of each of the last 12 UTC months; never the current slot; only our names.
  6. Kuma push monitor **"vault backup offsite"** (heartbeat 93600 s = 26 h, retries 0):
     `up` on success; `down` with the reason code after the last attempt fails, or 7 days
     before the PAT expires (`token_expiring`). A failed `up` is re-sent at +1/+5/+15 min.
- **Audit:** every attempt writes one audit row, `token_name` `system:backup`,
  `action` `backup`, `key_name` = slot, `status` `success`/`error`, and `details` with
  `trigger` (`scheduled`/`retry`/`catchup`), `attempt`, `stage`, `code`, `notes`, sizes,
  `secrets`/`tokens` row counts and `max_loop_delay_ms`. No names, values, URLs or tokens.
  The log line is `backup <slot> <trigger> attempt=<n> success|failed code=…`.
- **Off-site runs only in production** (`NODE_ENV=production`, set by the image). A dev box
  logs `backup off-site disabled: nonprod` and never uploads or pages.
- **Local files are plaintext SQLite** (secret values inside are AES-256-GCM under the
  master key, as in the live DB), so an on-box restore (§4) needs no age key.

### Host cron (root-only; daily, then monthly)

- `scripts/backup.sh` — WAL-safe hot snapshot via `sqlite3 ".backup"` (never `cp`),
  `PRAGMA integrity_check`, keep-last-N rotation **by count**.
- Line in `/etc/cron.d/secret-manager-backup` (mode 600, root; `<KUMA_PUSH_URL>` is the
  "vault backup" monitor's push URL, no `%`). Until the off-site copy is proven (decrypt
  test + two green scheduled slots) the schedule is daily, `45 21 * * *`, and the monitor is
  86400 s, retries 1, retry interval 7200 s. After that it is monthly:
  ```cron
  45 21 1 * * root umask 077; DB_PATH=/root/secrets-manager/data/secrets.db BACKUP_DIR=/var/backups/secret-manager KEEP=14 /bin/bash /root/secrets-manager/scripts/backup.sh >> /var/log/secret-manager-backup.log 2>&1 && curl -fsS -m 10 -o /dev/null "<KUMA_PUSH_URL>"
  ```
- Kuma push monitor **"vault backup (monthly host copy)"**: heartbeat 2073600 s (24 d),
  retries 1, retry interval 691200 s (8 d) → down about 32 days after the last good run.
  (Uptime Kuma 1.x caps both intervals at 24 days, hence the split.)
- It is the copy the vault process cannot delete. The deploy workflow's pre-deploy backups
  land in the same directory with the same `KEEP=14`, so frequent deploys push older
  monthlies out (a root-only copy always remains; its age varies).
- `sqlite3` must be installed on the host (`apt-get install -y sqlite3`): the deploy
  workflow's pre-deploy backup is fail-closed and aborts the deploy without it.
- If the vault was **down** at 21:45 UTC, root's `sqlite3` can create `secrets.db-wal` /
  `-shm` owned by root, and the service then fails to open the DB. Recovery:
  `chown 1000:1000 /root/secrets-manager/data/secrets.db-*`, then start the service.

### 3a. Off-site restore (VPS or disk lost)

Needs **both** handoff values from your store: the **age private key**
(`AGE-SECRET-KEY-1…`) and **`SECRET_MANAGER_MASTER_KEY`**. Without the master key the
restored DB opens but no secret value decrypts.

1. New box per §1 (checkout, `data/` owned by 1000, `sqlite3`, `curl`).
2. On the Mac, in your **own terminal** (not through Claude: the key is shown):
   download the newest `secrets-<slot>.db.gz.age` from the `daily` release in a browser
   signed in as `sarvinshrivastava` (the Mac's `gh` defaults to the work account, which
   cannot see this repo; with `gh`, first `gh auth switch -u sarvinshrivastava`). It is
   ciphertext; `~/Downloads` is fine.
3. Decrypt on a RAM disk so the key and the plaintext DB never touch persistent storage:
   ```sh
   [ ! -e /Volumes/vaultrestore ] || { echo "/Volumes/vaultrestore exists: eject it first"; false; } &&
   RESTDEV=$(hdiutil attach -nomount ram://262144) && diskutil erasevolume APFS vaultrestore "$RESTDEV" && mdutil -i off /Volumes/vaultrestore
   cd /Volumes/vaultrestore
   # copy the age private key from your store to the clipboard, then:
   pbpaste > key.txt && chmod 600 key.txt && pbcopy < /dev/null
   age -d -i key.txt ~/Downloads/secrets-<slot>.db.gz.age | gunzip > secrets.db
   sqlite3 secrets.db 'PRAGMA integrity_check;'                                         # ok
   sqlite3 secrets.db 'SELECT (SELECT count(*) FROM secrets), (SELECT count(*) FROM tokens);'  # = the audit row's counts
   ```
4. Copy `secrets.db` to the new box: `scp /Volumes/vaultrestore/secrets.db vps:/root/secrets-manager/data/secrets.db`,
   then on the box `chown 1000:1000 data/secrets.db && rm -f data/secrets.db-wal data/secrets.db-shm`.
5. Write `.env` with the stored master key (own terminal, `read -rs`, as in §3b), then
   `docker compose up -d` and the §4 step 4 checks.
6. Eject: `cd ~ && hdiutil detach "$RESTDEV" && rm ~/Downloads/secrets-<slot>.db.gz.age`.

Repeat steps 2–3 and 6 alone as a **decrypt test** (suggested quarterly): pass = `ok` and
both counts equal the slot's audit row.

### 3b. Key, token and monitor handling

- **After any `.env` change**, apply it with the **Deploy to VPS** workflow (or
  `docker compose up -d secret-manager`). `docker compose restart` does **not** re-read
  `env_file`. Dispatch the workflow from `main`, so the step that creates `backups/` is in
  the script that runs.
- **Secret `.env` lines** (PAT, push URL) are written in your **own terminal** with
  `read -rs`, never through Claude's `!` (its output enters the transcript):
  ```sh
  ssh -t vps 'cd /root/secrets-manager && read -rs -p "GitHub PAT: " T && echo && sed -i -E "/^SECRET_MANAGER_BACKUP_GITHUB_TOKEN=/d" .env && printf "SECRET_MANAGER_BACKUP_GITHUB_TOKEN=%s\n" "$T" >> .env && unset T && grep -c "^SECRET_MANAGER_BACKUP_" .env'
  ```
  (Same pattern for `SECRET_MANAGER_BACKUP_PUSH_URL`.)
- **PAT rotation** (before expiry; `token_expiring` pages 7 days ahead): GitHub →
  Settings → Developer settings → Fine-grained tokens → generate `vault-backup-upload`,
  resource owner `sarvinshrivastava`, only `vault-backups`, **Contents: Read and write**,
  366 days. Write it with the command above, deploy, check the next run is green, then
  revoke the old token. A lost PAT is not a problem: mint a new one.
- **Push URL rotation:** recreate the Kuma monitor (93600 s, retries 0), write the new URL,
  deploy.
- **age key rotation** (leaked, or lost after the handoff): on a Mac RAM disk,
  `age-keygen -o /Volumes/vaultkey/key.txt`, set the new public recipient in `.env`, deploy,
  hand off the new private key to your store, run a decrypt test. Old assets stay readable
  only with the old key: delete them from the release if it leaked.
- **Key lost before the handoff** (RAM disk gone before you stored it): generate a new
  pair, replace the recipient, deploy, delete the assets made for the lost key, and redo the
  handoff and decrypt test.
- **The private key never goes on the VPS.** Any `.env` value containing
  `AGE-SECRET-KEY-` or `AGE-PLUGIN-` disables off-site (`private_key_on_vps`) and pages.
- **Disabling off-site:** remove the recipient, repo, token and push-URL lines
  (`RELEASE_TAG` may stay), deploy, pause the monitor. Removing only some of the four while
  a push URL remains is `config_invalid` and pages; removing only the push URL also makes
  off-site `config_invalid`, but then nothing pages except the monitor's 26 h dead-man.
- **Before rolling the vault back** past this feature, pause "vault backup offsite".
- **Known limits (accepted):** anyone with root on the VPS can read the PAT from `.env` (or
  through `docker inspect`, like the master key) and delete the off-site assets; this design
  covers loss of the VPS, not its compromise. Kuma runs on the same VPS, so a dead VPS does
  not page.

### 3c. Failure codes

The audit row's `details.code` (and the Kuma `msg` on a final failure).

| Code | Cause | Action |
|---|---|---|
| `config_invalid` | a backup key in `.env` is missing or malformed (off-site needs recipient, repo, token **and** push URL; bad `UTC_TIME`/`KEEP_DAYS` fall back to defaults but still page) | fix `.env`, deploy |
| `private_key_on_vps` | an env value contains `AGE-SECRET-KEY-` / `AGE-PLUGIN-` | remove it from `.env` at once, deploy; treat that key as leaked (§3b) |
| `disk_low` | free space < 2 × (DB + WAL), or ENOSPC / `SQLITE_FULL` | §8 |
| `snapshot_failed` | the SQLite online backup failed | `docker compose logs`; §5 integrity check |
| `integrity_failed` | the fresh snapshot failed `integrity_check` | §5 on the live DB; do not ignore |
| `local_failed` | any other filesystem error in `backups/` (permissions, missing mount) | `ls -ld backups` must be `drwx------ 1000 1000`; re-run the deploy (it fixes the dir) |
| `release_not_found` | 404 on the `daily` tag: the release is missing (or a draft), **or** the PAT cannot see the repo | check the release is published; check the PAT's repository access |
| `github_auth` | 401, or 403 without rate-limit headers: PAT expired, revoked or missing Contents write | rotate the PAT (§3b) |
| `github_rate_limited` | 429, or 403 with `x-ratelimit-remaining: 0` / `retry-after` | retries usually clear it; wait for the next slot |
| `github_5xx` | GitHub server error | retries usually clear it; githubstatus.com |
| `github_http` | other non-2xx, or a paginated listing that left `api.github.com` | read the log line (status only); open an issue if it repeats |
| `github_network` | DNS/TCP/TLS/timeout to GitHub | check egress from the container (`docker exec secret-manager node -e "fetch('https://api.github.com').then(r=>console.log(r.status))"`) |
| `verify_mismatch` | the uploaded asset's digest/size/label/download hash does not match | retried; if it repeats, inspect the release assets |
| `token_expiring` | the PAT expires within 7 days (the copy **was** made) | rotate the PAT (§3b) |
| `slot_asset_foreign` | the slot's asset exists, uploaded, without our `sha256-` label (made by hand?) | inspect it; delete it in the release UI if it is not needed; the next slot proceeds |
| `timeout` | the run exceeded 20 min, or was cut by a shutdown | logs; retried |
| `internal` | a bug (the log has only the error class name) | logs; open an issue |

Notes (on an otherwise successful run, `details.notes`):

| Note | Meaning | Action |
|---|---|---|
| `retention_failed` | a remote retention delete/list failed | none; the next slot repeats it |
| `kuma_failed` | the `up` push failed; re-sent at +1/+5/+15 min | check Kuma reachability from the container |
| `local_rotation_failed` | an old local file could not be deleted | `ls -l backups/` |
| `large_db` | the DB is above 64 MB | the backup buffers ~3× the DB in memory (`mem_limit: 256m`): revisit the design |

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
   - **Backups piling up** — host copies: lower `KEEP` in the cron job / prune
     `/var/backups/secret-manager`. In-process copies: `du -sh
     /root/secrets-manager/backups` (14 days × DB size); lower
     `SECRET_MANAGER_BACKUP_KEEP_DAYS` and deploy, or delete the oldest
     `secrets-YYYYMMDD.db` files by hand. The backup itself refuses to start with
     `disk_low` when free space is under 2 × (DB + WAL).
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
5. `install -d -m 700 -o 1000 -g 1000 backups` — creates (or fixes) the in-process
   backup dir (§3) before the container starts; a bind-mounted dir Docker creates on its
   own would be root-owned and the backup would fail with `local_failed`.
6. `docker compose up --build -d`.

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
  (bind mount + `USER node`; see §1). `backups/` is created by the workflow itself (step 5).
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
