import { loadSettings } from "./config.js";
import { CryptoManager } from "./crypto.js";
import { Database } from "./database.js";
import { RateLimiter } from "./rate-limit.js";
import { createApp } from "./app.js";

const settings = loadSettings();
const crypto = new CryptoManager(settings.masterKey);
const db = new Database(settings.dbPath);
const rateLimiter = new RateLimiter(settings.rateLimitPerMinute);

// ── Bootstrap tokens from env vars ────────────────────────────────────────
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

// ── PBKDF2 master key migration ────────────────────────────────────────────
// Re-encrypt any secrets still under the old SHA256-derived key. Iterates
// PER ROW (a mixed legacy/PBKDF2 DB must not crash boot or strand rows): try
// the PBKDF2 key first (already migrated), else the legacy key (migrate), else
// count as failed. A canary then aborts boot if any row decrypts under NEITHER
// key — that means the master key is wrong and continuing would corrupt data.
function migrateEncryptionIfNeeded() {
  const rows = db.listSecretsForExport();
  if (rows.length === 0) return;

  let migrated = 0;
  let alreadyOk = 0;
  let failed = 0;

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
        failed += 1;
      }
    }
  });

  migrateTx(rows);

  if (migrated > 0) {
    console.info(`Migrated ${migrated} secret(s) to PBKDF2-derived key.`);
  }

  // Canary: the master key must be able to decrypt existing secrets.
  if (failed > 0) {
    console.error(
      `FATAL: ${failed} stored secret(s) could not be decrypted with either the ` +
        "PBKDF2 or legacy master key. SECRET_MANAGER_MASTER_KEY is likely wrong — " +
        "refusing to start to avoid corrupting the vault.",
    );
    process.exit(1);
  }
}

migrateEncryptionIfNeeded();

// ── Audit log retention ────────────────────────────────────────────────────
function pruneAuditLogs() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.auditLogRetentionDays);
  db.pruneAuditLogs(cutoff.toISOString());
}

pruneAuditLogs();
setInterval(pruneAuditLogs, 24 * 60 * 60 * 1000);

// ── Start HTTP server ──────────────────────────────────────────────────────
const app = createApp(settings, db, crypto, rateLimiter);

const server = app.listen(settings.port, settings.host, () => {
  console.info(`Secret Manager listening on ${settings.host}:${settings.port}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.info("SIGTERM received, draining in-flight requests...");
  server.close(() => {
    console.info("HTTP server closed cleanly.");
    process.exit(0);
  });
});
