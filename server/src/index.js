import { pathToFileURL } from "node:url";
import { loadSettings } from "./config.js";
import { CryptoManager } from "./crypto.js";
import { Database } from "./database.js";
import { RateLimiter } from "./rate-limit.js";
import { createApp } from "./app.js";

// ── PBKDF2 master key migration ────────────────────────────────────────────
// Re-encrypt any secrets still under the old SHA256-derived key. Iterates
// PER ROW (a mixed legacy/PBKDF2 DB must not crash boot or strand rows): try
// the PBKDF2 key first (already migrated), else the legacy key (migrate), else
// record the row id as failed. Pure + testable: RETURNS a summary instead of
// calling process.exit — the caller classifies the result and decides.
//   { migrated, alreadyOk, failed } where `failed` is an array of row ids that
//   decrypt under NEITHER key.
export function migrateEncryptionIfNeeded(db, crypto) {
  const rows = db.listSecretsForExport();
  const failed = [];
  let migrated = 0;
  let alreadyOk = 0;

  if (rows.length === 0) return { migrated, alreadyOk, failed };

  // One transaction for all re-encrypt writes — a mid-batch throw rolls back.
  const migrateTx = db.db.transaction((entries) => {
    for (const row of entries) {
      try {
        crypto.decryptValue(row.nonce, row.ciphertext);
        alreadyOk += 1;
        continue;
      } catch {
        // not PBKDF2-encrypted — try legacy below
      }

      try {
        const plaintext = crypto.decryptWithLegacyKey(
          row.nonce,
          row.ciphertext,
        );
        const encrypted = crypto.encryptValue(plaintext);
        db.migrateSecretEncryption(
          row.id,
          encrypted.nonce,
          encrypted.ciphertext,
        );
        migrated += 1;
      } catch {
        failed.push(row.id);
      }
    }
  });

  migrateTx(rows);

  return { migrated, alreadyOk, failed };
}

// ── Boot ────────────────────────────────────────────────────────────────────
function main() {
  const settings = loadSettings();
  const crypto = new CryptoManager(settings.masterKey);
  const db = new Database(settings.dbPath);
  const rateLimiter = new RateLimiter(settings.rateLimitPerMinute);

  // Bootstrap tokens from env vars
  if (settings.adminToken) {
    const hashed = crypto.hashToken(settings.adminToken);
    db.upsertToken("admin", "write", hashed.salt, hashed.digest);
    console.info("Bootstrapped write token: admin");
  }

  if (settings.readToken) {
    const hashed = crypto.hashToken(settings.readToken);
    db.upsertToken("reader", "read", hashed.salt, hashed.digest);
    console.info("Bootstrapped read token: reader");
  }

  if (db.countWriteTokens() === 0) {
    throw new Error(
      "No active write tokens found. Set SECRET_MANAGER_ADMIN_TOKEN before starting, or create a write token first.",
    );
  }

  // Migrate + classify the result.
  const { migrated, alreadyOk, failed } = migrateEncryptionIfNeeded(db, crypto);
  if (migrated > 0) {
    console.info(`Migrated ${migrated} secret(s) to PBKDF2-derived key.`);
  }
  if (failed.length > 0) {
    if (migrated === 0 && alreadyOk === 0) {
      // EVERY row failed → the master key can decrypt nothing → wrong key.
      // Continuing would let new writes land under a key that can't read the
      // vault. Refuse to start.
      console.error(
        `FATAL: all ${failed.length} stored secret(s) failed to decrypt with ` +
          "either the PBKDF2 or legacy master key. SECRET_MANAGER_MASTER_KEY is " +
          "likely wrong — refusing to start to avoid corrupting the vault.",
      );
      process.exit(1);
    }
    // Some rows decrypted fine → the key is right; the failures are isolated
    // corruption. Warn per row and continue rather than strand the whole vault.
    for (const id of failed) {
      console.warn(
        `WARN: secret id=${id} could not be decrypted (isolated corruption). ` +
          "Leaving it in place and continuing.",
      );
    }
  }

  // Audit log retention
  function pruneAuditLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - settings.auditLogRetentionDays);
    db.pruneAuditLogs(cutoff.toISOString());
  }

  pruneAuditLogs();
  // unref() so this daily timer never keeps the process alive during shutdown.
  const pruneTimer = setInterval(pruneAuditLogs, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  // Start HTTP server
  const app = createApp(settings, db, crypto, rateLimiter);
  const server = app.listen(settings.port, settings.host, () => {
    console.info(
      `Secret Manager listening on ${settings.host}:${settings.port}`,
    );
  });

  // Graceful shutdown — SIGINT and SIGTERM share one handler.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`${signal} received, draining in-flight requests...`);
    server.close(() => {
      try {
        // better-sqlite3: close() checkpoints the WAL back into the main db.
        db.db.close();
      } catch (err) {
        console.error(`Error closing database: ${err.message}`);
      }
      console.info("HTTP server closed cleanly.");
      process.exit(0);
    });
    // Backstop: if connections don't drain in 10s, force-exit. unref() so the
    // timer itself never blocks an otherwise-clean exit.
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only boot when run directly — importing this module (e.g. in tests to reach
// migrateEncryptionIfNeeded) must not open a DB, bind a port, or exit.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
