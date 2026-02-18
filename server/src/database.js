import fs from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";

function utcNowIso() {
  return new Date().toISOString();
}

export class Database {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath) || ".", { recursive: true });
    this.db = new DatabaseDriver(dbPath);
    this.initSchema();
    this._prepareStatements();
  }

  initSchema() {
    this.db.pragma("journal_mode = WAL");

    // Secrets: immutable (no updated_at), auto-increment id, UNIQUE(folder, key)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        folder      TEXT NOT NULL DEFAULT 'Root',
        nonce       BLOB NOT NULL,
        ciphertext  BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE (folder, key)
      );

      CREATE TABLE IF NOT EXISTS tokens (
        name        TEXT PRIMARY KEY,
        role        TEXT NOT NULL CHECK(role IN ('read', 'write')),
        salt        BLOB NOT NULL,
        token_hash  BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        expires_at  TEXT,
        revoked_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        token_name  TEXT,
        action      TEXT NOT NULL,
        key_name    TEXT,
        status      TEXT NOT NULL,
        ip_address  TEXT,
        details     TEXT
      );
    `);

    // Secrets table migration: rebuild if missing id column (old schema had no autoincrement PK)
    const secretCols = this.db.prepare("PRAGMA table_info(secrets)").all().map((c) => c.name);
    if (!secretCols.includes("id")) {
      this.db.exec(`
        ALTER TABLE secrets RENAME TO secrets_old;

        CREATE TABLE secrets (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          key         TEXT NOT NULL,
          folder      TEXT NOT NULL DEFAULT 'Root',
          nonce       BLOB NOT NULL,
          ciphertext  BLOB NOT NULL,
          created_at  TEXT NOT NULL,
          UNIQUE (folder, key)
        );

        INSERT INTO secrets (key, folder, nonce, ciphertext, created_at)
        SELECT key, COALESCE(folder, 'Root'), nonce, ciphertext, COALESCE(updated_at, datetime('now'))
        FROM secrets_old;

        DROP TABLE secrets_old;
      `);
    }

    // Lightweight migrations for tokens table (if upgrading existing DB)
    const tokenCols = this.db.prepare("PRAGMA table_info(tokens)").all().map((c) => c.name);
    if (!tokenCols.includes("expires_at")) {
      this.db.exec("ALTER TABLE tokens ADD COLUMN expires_at TEXT");
    }
    if (!tokenCols.includes("revoked_at")) {
      this.db.exec("ALTER TABLE tokens ADD COLUMN revoked_at TEXT");
    }
  }

  _prepareStatements() {
    // Secrets
    this.listSecretKeysStmt = this.db.prepare(
      "SELECT key, folder FROM secrets ORDER BY key ASC",
    );
    this.getSecretStmt = this.db.prepare(
      "SELECT id, key, folder, nonce, ciphertext, created_at FROM secrets WHERE folder = ? AND key = ?",
    );
    this.createSecretStmt = this.db.prepare(
      "INSERT OR IGNORE INTO secrets (key, folder, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.deleteSecretStmt = this.db.prepare(
      "DELETE FROM secrets WHERE folder = ? AND key = ?",
    );
    this.renameFolderStmt = this.db.prepare(
      "UPDATE secrets SET folder = ? WHERE folder = ?",
    );
    this.listSecretsForExportStmt = this.db.prepare(
      "SELECT id, key, folder, nonce, ciphertext FROM secrets ORDER BY key ASC",
    );
    this.migrateSecretEncryptionStmt = this.db.prepare(
      "UPDATE secrets SET nonce = ?, ciphertext = ? WHERE id = ?",
    );

    // Tokens
    this.countWriteTokensStmt = this.db.prepare(
      "SELECT COUNT(*) AS total FROM tokens WHERE role = 'write' AND revoked_at IS NULL",
    );
    this.listTokensStmt = this.db.prepare(
      "SELECT name, role, salt, token_hash, created_at, updated_at, expires_at, revoked_at FROM tokens",
    );
    this.upsertTokenStmt = this.db.prepare(`
      INSERT INTO tokens (name, role, salt, token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        role = excluded.role,
        salt = excluded.salt,
        token_hash = excluded.token_hash,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `);
    this.createTokenStmt = this.db.prepare(`
      INSERT INTO tokens (name, role, salt, token_hash, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.getTokenByNameStmt = this.db.prepare(
      "SELECT name, role, salt, token_hash, created_at, updated_at, expires_at, revoked_at FROM tokens WHERE name = ?",
    );
    this.revokeTokenStmt = this.db.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE name = ?",
    );
    this.rotateTokenStmt = this.db.prepare(
      "UPDATE tokens SET salt = ?, token_hash = ?, updated_at = ?, revoked_at = NULL WHERE name = ?",
    );

    // Audit logs
    this.insertAuditLogStmt = this.db.prepare(`
      INSERT INTO audit_logs (timestamp, token_name, action, key_name, status, ip_address, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.pruneAuditLogsStmt = this.db.prepare(
      "DELETE FROM audit_logs WHERE timestamp < ?",
    );
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  listSecretKeys() {
    return this.listSecretKeysStmt.all().map((row) => ({
      key: row.key,
      folder: row.folder,
    }));
  }

  getSecret(folder, key) {
    return this.getSecretStmt.get(folder, key) || null;
  }

  /** Returns true if inserted, false if (folder, key) already exists. */
  createSecret(folder, key, nonce, ciphertext) {
    const now = utcNowIso();
    const result = this.createSecretStmt.run(key, folder, nonce, ciphertext, now);
    return result.changes > 0;
  }

  deleteSecret(folder, key) {
    const result = this.deleteSecretStmt.run(folder, key);
    return result.changes > 0;
  }

  renameFolder(fromFolder, toFolder) {
    const result = this.renameFolderStmt.run(toFolder, fromFolder);
    return Number(result.changes || 0);
  }

  listSecretsForExport() {
    return this.listSecretsForExportStmt.all();
  }

  /** Migration-only: re-encrypt a secret by id without immutability check. */
  migrateSecretEncryption(id, nonce, ciphertext) {
    this.migrateSecretEncryptionStmt.run(nonce, ciphertext, id);
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  countWriteTokens() {
    const row = this.countWriteTokensStmt.get();
    return Number(row.total || 0);
  }

  listTokens() {
    return this.listTokensStmt.all();
  }

  /** Bootstrap upsert — used only for env-var tokens at startup. Clears revoked_at. */
  upsertToken(name, role, salt, tokenHash) {
    const now = utcNowIso();
    this.upsertTokenStmt.run(name, role, salt, tokenHash, now, now);
  }

  /** API create — fails if name already exists and is not revoked. */
  createToken(name, role, salt, tokenHash, expiresAt = null) {
    const now = utcNowIso();
    this.createTokenStmt.run(name, role, salt, tokenHash, now, now, expiresAt);
  }

  getTokenByName(name) {
    return this.getTokenByNameStmt.get(name) || null;
  }

  revokeToken(name) {
    this.revokeTokenStmt.run(utcNowIso(), name);
  }

  rotateToken(name, salt, tokenHash) {
    this.rotateTokenStmt.run(salt, tokenHash, utcNowIso(), name);
  }

  // ── Audit logs ───────────────────────────────────────────────────────────

  listAuditLogs({ action = null, status = null, key = null, tokenName = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];

    if (action) {
      clauses.push("action = ?");
      params.push(action);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (key) {
      clauses.push("key_name LIKE ?");
      params.push(`%${key}%`);
    }
    if (tokenName) {
      clauses.push("token_name LIKE ?");
      params.push(`%${tokenName}%`);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const statement = this.db.prepare(`
      SELECT id, timestamp, token_name, action, key_name, status, ip_address, details
      FROM audit_logs
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `);

    return statement.all(...params, limit).map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      token_name: row.token_name,
      action: row.action,
      key_name: row.key_name,
      status: row.status,
      ip_address: row.ip_address,
      details: row.details,
    }));
  }

  insertAuditLog({ tokenName, action, keyName, status, ipAddress, details = null }) {
    this.insertAuditLogStmt.run(
      utcNowIso(),
      tokenName,
      action,
      keyName,
      status,
      ipAddress,
      details,
    );
  }

  pruneAuditLogs(cutoffIso) {
    this.pruneAuditLogsStmt.run(cutoffIso);
  }
}
