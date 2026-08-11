import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";

import { CryptoManager } from "../src/crypto.js";
import { Database } from "../src/database.js";
import { RateLimiter } from "../src/rate-limit.js";
import { createApp } from "../src/app.js";

export const MASTER_KEY = "test-master-key-do-not-use-in-prod";

// ONE CryptoManager for the whole file. Its constructor + every hashToken are
// 210k-iter PBKDF2 (~32ms each), so construct once and cache token hashes.
export const cryptoManager = new CryptoManager(MASTER_KEY);

// Cache {salt, digest} per secret string so re-seeding the same logical token
// across many temp DBs never re-pays the PBKDF2 cost.
const hashCache = new Map();
function hashSecret(secret) {
  if (!hashCache.has(secret))
    hashCache.set(secret, cryptoManager.hashToken(secret));
  return hashCache.get(secret);
}

function tempDbPath() {
  // better-sqlite3 needs a real file for WAL — unique per context, cleaned up.
  return path.join(
    os.tmpdir(),
    `sm-test-${nodeCrypto.randomBytes(8).toString("hex")}.db`,
  );
}

const openDbs = new Set();

/**
 * Build the app via the real factory over a temp-file SQLite DB.
 * Returns { app, db, cleanup, settings, rateLimiter }.
 */
export function makeApp({
  rateLimitPerMinute = 10000,
  publicRateLimitPerMinute = 10000,
  trustedProxyIps = ["127.0.0.1", "::1"],
} = {}) {
  const dbPath = tempDbPath();
  const db = new Database(dbPath);
  openDbs.add({ db, dbPath });

  const rateLimiter = new RateLimiter(rateLimitPerMinute, 60, {
    autoSweep: false,
  });
  const settings = { publicRateLimitPerMinute, trustedProxyIps };
  const app = createApp(settings, db, cryptoManager, rateLimiter);

  function cleanup() {
    try {
      db.db.close();
    } catch {
      /* already closed */
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return { app, db, cleanup, settings, rateLimiter };
}

/**
 * Insert a token row and return its `<name>.<secret>` wire token.
 * secret defaults to a deterministic value per name so the hash is cached.
 */
export function addToken(
  db,
  { name, role = "read", scope = "*", expiresAt = null, secret = null } = {},
) {
  const rawSecret = secret || `secret-${name}-abcdef0123456789`;
  const hashed = hashSecret(rawSecret);
  db.createToken(name, role, hashed.salt, hashed.digest, expiresAt, scope);
  return `${name}.${rawSecret}`;
}

/**
 * Insert a BARE (legacy/bootstrap-style) token: the stored hash covers the full
 * raw string, and the wire token has no `<name>.` prefix. Exercises the
 * back-compat capped-scan auth path.
 */
export function addBareToken(
  db,
  { name, role = "write", scope = "*", raw = null } = {},
) {
  const rawToken = raw || `bare-${name}-0123456789abcdef`;
  const hashed = hashSecret(rawToken);
  db.upsertToken(name, role, hashed.salt, hashed.digest, scope);
  return rawToken;
}

export function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

export function isoInPast(seconds = 3600) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

export function isoInFuture(seconds = 3600) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}
