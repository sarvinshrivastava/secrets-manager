// Closed set of reason codes. They are the only text a failure ever carries
// into logs, audit rows and Kuma messages: never a value, URL or token.

// Run outcomes (fail the slot; Kuma msg on a final failure).
export const CODES = Object.freeze([
  "config_invalid",
  "private_key_on_vps",
  "disk_low", // free-space pre-check, or ENOSPC anywhere in the local stage
  "snapshot_failed", // db.backup rejected (not ENOSPC/EACCES)
  "integrity_failed",
  "local_failed", // any other fs error in the local stage
  "release_not_found", // 404 on the tag: release missing OR the PAT cannot see the repo
  "github_auth", // 401, or 403 without rate-limit headers
  "github_rate_limited", // 429, or 403 with x-ratelimit-remaining: 0 / retry-after
  "github_5xx",
  "github_http",
  "github_network",
  "verify_mismatch",
  "token_expiring",
  "slot_asset_foreign", // current slot's asset uploaded without our label
  "timeout", // run deadline exceeded, or the run was abandoned
  "internal", // any non-BackupError (a bug)
]);

// Notes recorded on an otherwise successful run (never fail the slot).
export const NOTES = Object.freeze([
  "retention_failed",
  "kuma_failed",
  "local_rotation_failed",
  "large_db",
]);

export const NON_RETRYABLE = new Set([
  "config_invalid",
  "private_key_on_vps",
  "token_expiring",
  "slot_asset_foreign",
]);

export class BackupError extends Error {
  constructor(code, { cause, status } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "BackupError";
    this.code = CODES.includes(code) ? code : "internal";
    if (status !== undefined) this.status = status;
  }

  // The only source of retryability.
  get retryable() {
    return !NON_RETRYABLE.has(this.code);
  }
}

function isFsError(err) {
  return typeof err?.code === "string" && typeof err?.syscall === "string";
}

// Map anything thrown into a BackupError. `stage` is "local" (fs work around
// the snapshot), "snapshot" (db.backup itself) or anything else.
export function toBackupError(err, stage) {
  if (err instanceof BackupError) return err;
  const code = err?.code;
  if (code === "ENOSPC" || code === "SQLITE_FULL") {
    return new BackupError("disk_low", { cause: err });
  }
  if (stage === "local" || stage === "snapshot") {
    if (isFsError(err)) return new BackupError("local_failed", { cause: err });
    if (stage === "snapshot" || err?.name === "SqliteError") {
      return new BackupError("snapshot_failed", { cause: err });
    }
  }
  return new BackupError("internal", { cause: err });
}
