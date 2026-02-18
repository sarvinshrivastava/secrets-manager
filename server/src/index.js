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
// Detect secrets encrypted with the old SHA256-derived key and re-encrypt with PBKDF2.
function migrateEncryptionIfNeeded() {
  const rows = db.listSecretsForExport();
  if (rows.length === 0) return;

  let needsMigration = false;
  try {
    crypto.decryptWithLegacyKey(rows[0].nonce, rows[0].ciphertext);
    needsMigration = true;
  } catch {
    // Already using PBKDF2 key — no migration needed
    return;
  }

  if (needsMigration) {
    console.info(`Migrating ${rows.length} secret(s) to PBKDF2-derived key...`);
    const migrateTx = db.db.transaction((entries) => {
      for (const row of entries) {
        const plaintext = crypto.decryptWithLegacyKey(row.nonce, row.ciphertext);
        const encrypted = crypto.encryptValue(plaintext);
        db.migrateSecretEncryption(row.id, encrypted.nonce, encrypted.ciphertext);
      }
    });
    migrateTx(rows);
    console.info("Migration complete.");
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
