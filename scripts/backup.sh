#!/usr/bin/env bash
#
# backup.sh — safe hot backup of the Secret Manager SQLite database.
#
# WHY NOT `cp`:
#   The DB runs in WAL mode (secrets.db + secrets.db-wal + secrets.db-shm). A
#   plain `cp secrets.db ...` copies only the main file and can miss committed
#   pages still living in the -wal — producing a silently corrupt/torn backup.
#   `sqlite3 ".backup"` (used here) takes a read lock and copies a consistent
#   snapshot of the whole database, WAL included. It is safe while the container
#   is running — no need to stop the service.
#
# OFF-SITE IS NOT OPTIONAL:
#   This DB is the ONLY copy of every CI secret and every token hash. A backup
#   sitting on the same VPS disk dies with the VPS. After this script writes a
#   local snapshot, SHIP IT OFF THE BOX — e.g. rclone/aws s3 cp to object
#   storage, or scp to another host. The backup file is still AES-256-GCM
#   encrypted at the value level, BUT anyone who also has SECRET_MANAGER_MASTER_KEY
#   can decrypt it, so treat the backup as highly sensitive: private bucket,
#   encrypted transport, restricted access. Do NOT store the master key next to
#   the backups.
#
# USAGE:
#   DB_PATH=/opt/secret-manager/data/secrets.db \
#   BACKUP_DIR=/var/backups/secret-manager \
#   KEEP=14 \
#     ./scripts/backup.sh
#
# CRON (daily 03:15, log to a file):
#   15 3 * * * DB_PATH=/opt/secret-manager/data/secrets.db BACKUP_DIR=/var/backups/secret-manager /opt/secret-manager/scripts/backup.sh >> /var/log/secret-manager-backup.log 2>&1
#
set -euo pipefail

# ---- Config (override via env) ----------------------------------------------
DB_PATH="${DB_PATH:-data/secrets.db}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${KEEP:-14}"            # keep the last N backups, prune older
SQLITE_BIN="${SQLITE_BIN:-sqlite3}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

command -v "$SQLITE_BIN" >/dev/null 2>&1 \
  || die "$SQLITE_BIN not found. Install sqlite3 (apt-get install -y sqlite3)."
[ -f "$DB_PATH" ] || die "database not found at DB_PATH=$DB_PATH"

mkdir -p "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/secrets-$TS.db"

# ---- Consistent online snapshot ---------------------------------------------
# .backup is WAL-safe and locks only briefly. VACUUM INTO is an equivalent
# alternative that also defragments: sqlite3 "$DB_PATH" "VACUUM INTO '$OUT'"
log "backing up $DB_PATH -> $OUT"
"$SQLITE_BIN" "$DB_PATH" ".backup '$OUT'"

# ---- Verify the snapshot before trusting it ---------------------------------
INTEGRITY="$("$SQLITE_BIN" "$OUT" 'PRAGMA integrity_check;' 2>&1 || true)"
if [ "$INTEGRITY" != "ok" ]; then
  rm -f "$OUT"
  die "integrity_check failed on fresh backup: $INTEGRITY"
fi
log "integrity_check ok ($(du -h "$OUT" | cut -f1))"

# ---- Rotation: keep last N --------------------------------------------------
# Newest-first, drop everything past the Nth.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/secrets-*.db 2>/dev/null | tail -n +"$((KEEP + 1))")
if [ "${#OLD[@]}" -gt 0 ]; then
  log "pruning ${#OLD[@]} old backup(s) beyond KEEP=$KEEP"
  rm -f "${OLD[@]}"
fi

log "done. Remember to ship $OUT OFF the VPS (object storage / another host)."
