import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { Database } from "../src/database.js";
import { migrateEncryptionIfNeeded } from "../src/index.js";
import { makeApp, cryptoManager } from "./helpers.js";

// AES-256-GCM encrypt with an arbitrary 32-byte key, producing the same
// { nonce, ciphertext=ct||tag } layout the app stores. Lets us fabricate rows
// encrypted under the legacy key or a totally-unrelated ("wrong") key.
function encryptWith(key, value) {
  const nonce = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: Buffer.concat([ct, tag]) };
}

const tempPaths = [];
function tempDbPath() {
  const p = path.join(
    os.tmpdir(),
    `sm-mig-${nodeCrypto.randomBytes(8).toString("hex")}.db`,
  );
  tempPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(p + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

describe("migrateEncryptionIfNeeded", () => {
  it("migrates legacy rows, leaves already-PBKDF2 rows, no failures", () => {
    const ctx = makeApp();
    // One PBKDF2 (already-migrated) row.
    const okEnc = cryptoManager.encryptValue("already-ok");
    ctx.db.createSecret("Root", "OK", okEnc.nonce, okEnc.ciphertext);
    // One legacy-key row.
    const legEnc = encryptWith(cryptoManager.legacyKey, "legacy-value");
    ctx.db.createSecret("Root", "LEG", legEnc.nonce, legEnc.ciphertext);

    const result = migrateEncryptionIfNeeded(ctx.db, cryptoManager);
    expect(result.migrated).toBe(1);
    expect(result.alreadyOk).toBe(1);
    expect(result.failed).toEqual([]);

    // The legacy row now decrypts under the current PBKDF2 key.
    const row = ctx.db.getSecret("Root", "LEG");
    expect(cryptoManager.decryptValue(row.nonce, row.ciphertext)).toBe(
      "legacy-value",
    );
    ctx.cleanup();
  });

  it("records a row encrypted under an unrelated key as failed (some-fail)", () => {
    const ctx = makeApp();
    const okEnc = cryptoManager.encryptValue("fine");
    ctx.db.createSecret("Root", "OK", okEnc.nonce, okEnc.ciphertext);

    const wrongKey = nodeCrypto.randomBytes(32);
    const badEnc = encryptWith(wrongKey, "unreadable");
    ctx.db.createSecret("Root", "BAD", badEnc.nonce, badEnc.ciphertext);
    const badId = ctx.db.getSecret("Root", "BAD").id;

    const result = migrateEncryptionIfNeeded(ctx.db, cryptoManager);
    expect(result.failed).toEqual([badId]);
    expect(result.alreadyOk).toBe(1);
    // some-fail classification: not (migrated===0 && alreadyOk===0) → continue.
    const wrongKeyBoot =
      result.failed.length > 0 &&
      result.migrated === 0 &&
      result.alreadyOk === 0;
    expect(wrongKeyBoot).toBe(false);
    ctx.cleanup();
  });

  it("classifies all-rows-fail as the wrong-master-key case", () => {
    const ctx = makeApp();
    const wrongKey = nodeCrypto.randomBytes(32);
    for (const key of ["A", "B"]) {
      const enc = encryptWith(wrongKey, `v-${key}`);
      ctx.db.createSecret("Root", key, enc.nonce, enc.ciphertext);
    }

    const result = migrateEncryptionIfNeeded(ctx.db, cryptoManager);
    expect(result.failed.length).toBe(2);
    expect(result.migrated).toBe(0);
    expect(result.alreadyOk).toBe(0);
    // wrong-master-key classification (boot would process.exit(1)).
    const wrongKeyBoot =
      result.failed.length > 0 &&
      result.migrated === 0 &&
      result.alreadyOk === 0;
    expect(wrongKeyBoot).toBe(true);
    ctx.cleanup();
  });

  it("is a no-op on an empty vault", () => {
    const ctx = makeApp();
    const result = migrateEncryptionIfNeeded(ctx.db, cryptoManager);
    expect(result).toEqual({ migrated: 0, alreadyOk: 0, failed: [] });
    ctx.cleanup();
  });
});

describe("tokens schema migration (scope column backfill)", () => {
  it("backfills scope='*' for rows from a pre-scope tokens table", () => {
    const p = tempDbPath();

    // Fabricate an OLD-schema tokens table with NO scope column.
    const raw = new BetterSqlite3(p);
    raw.exec(`
      CREATE TABLE tokens (
        name        TEXT PRIMARY KEY,
        role        TEXT NOT NULL CHECK(role IN ('read', 'write')),
        salt        BLOB NOT NULL,
        token_hash  BLOB NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        expires_at  TEXT,
        revoked_at  TEXT
      );
    `);
    const now = new Date().toISOString();
    raw
      .prepare(
        "INSERT INTO tokens (name, role, salt, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("legacy", "write", Buffer.alloc(16), Buffer.alloc(32), now, now);
    raw.close();

    // Opening via the app Database runs the lightweight migration.
    const db = new Database(p);
    const row = db.getTokenByName("legacy");
    expect(row.scope).toBe("*");
    db.db.close();
  });
});
