import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { Database } from "../src/database.js";
import { BackupError } from "../src/backup/errors.js";
import {
  ensureLocalSnapshot,
  cleanInflight,
  checkFreeSpace,
  verifySnapshot,
  listLocal,
  INFLIGHT,
  LARGE_DB_BYTES,
} from "../src/backup/snapshot.js";

// Real better-sqlite3, no fake timers: db.backup steps through setImmediate.
let root;
let dbPath;
let db;
let dir;

function seed(database, n, prefix = "k") {
  for (let i = 0; i < n; i += 1) {
    database.createSecret("Root", `${prefix}${i}`, Buffer.alloc(12, 1), Buffer.alloc(32, 2));
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sm-snap-"));
  dbPath = path.join(root, "data", "secrets.db");
  dir = path.join(root, "backups");
  db = new Database(dbPath);
  seed(db, 25);
  db.createToken("t1", "read", Buffer.alloc(16), Buffer.alloc(32));
  // Rows written after WAL mode is on stay in the -wal until a checkpoint.
  seed(db, 5, "late");
});

afterEach(() => {
  try {
    db.db.close();
  } catch {
    /* already closed */
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* absent */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (extra = {}) =>
  ensureLocalSnapshot(db, { dir, slot: "20261020", dbPath, ...extra });

describe("ensureLocalSnapshot", () => {
  it("writes a verified, self-contained, 0600 snapshot", async () => {
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
    const prev = process.umask(0o022);
    let res;
    try {
      res = await run();
    } finally {
      process.umask(prev);
    }
    expect(res.reused).toBe(false);
    expect(res.file).toBe(path.join(dir, "secrets-20261020.db"));
    expect(res.counts).toEqual({ secrets: 30, tokens: 1 });
    expect(res.bytes).toBeGreaterThan(0);
    expect(fs.statSync(res.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir).sort()).toEqual(["secrets-20261020.db"]);
    // Header bytes 18/19 = 1: rollback journal, not WAL (2).
    const header = fs.readFileSync(res.file).subarray(18, 20);
    expect([...header]).toEqual([1, 1]);
    const h = new DatabaseDriver(res.file, { readonly: true });
    expect(h.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    h.close();
    expect(fs.readdirSync(dir)).toEqual(["secrets-20261020.db"]);
  });

  it("reuses the slot file and reads counts from it, not the live DB", async () => {
    const first = await run();
    const before = fs.readFileSync(first.file);
    seed(db, 7, "after");
    const second = await run();
    expect(second.reused).toBe(true);
    expect(second.counts).toEqual({ secrets: 30, tokens: 1 });
    expect(fs.readFileSync(first.file).equals(before)).toBe(true);
  });

  it("replaces a corrupt slot file", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "secrets-20261020.db");
    fs.writeFileSync(file, Buffer.from("SQLite format 3\0truncated"));
    const res = await run();
    expect(res.reused).toBe(false);
    expect(res.counts.secrets).toBe(30);
  });

  it("cleanInflight removes the temp file and its sidecars", () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const s of ["", "-wal", "-shm", "-journal"]) {
      fs.writeFileSync(path.join(dir, INFLIGHT + s), "x");
    }
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    cleanInflight(dir);
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("refuses with disk_low when free space is short, writing nothing", async () => {
    const statfs = () => ({ bavail: 1, bsize: 4096 });
    await expect(run({ statfs })).rejects.toMatchObject({ code: "disk_low" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("checkFreeSpace passes with room", () => {
    fs.mkdirSync(dir, { recursive: true });
    expect(() =>
      checkFreeSpace(dir, dbPath, () => ({ bavail: 1e9, bsize: 4096 })),
    ).not.toThrow();
  });

  it("maps a DB closed mid-backup to snapshot_failed and leaves no temp file", async () => {
    const p = run();
    db.db.close();
    await expect(p).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("maps EACCES on an existing read-only dir to local_failed", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    await expect(run()).rejects.toMatchObject({ code: "local_failed" });
  });

  it("notes large_db above 64 MB (injected size)", async () => {
    const res = await run({ sizeOf: () => LARGE_DB_BYTES + 1 });
    expect(res.notes).toEqual(["large_db"]);
    const small = await run();
    expect(small.notes).toEqual([]);
  });

  it("stops before any mutation when the guard throws", async () => {
    await expect(
      run({
        guard: () => {
          throw new BackupError("timeout");
        },
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("an abandoned run after db.backup leaves the temp file for the next cleanInflight", async () => {
    let calls = 0;
    const guard = () => {
      calls += 1;
      if (calls >= 4) throw new BackupError("timeout"); // the check after db.backup
    };
    await expect(run({ guard })).rejects.toMatchObject({ code: "timeout" });
    expect(fs.existsSync(path.join(dir, INFLIGHT))).toBe(true);
    expect(fs.existsSync(path.join(dir, "secrets-20261020.db"))).toBe(false);
    cleanInflight(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("verifySnapshot / listLocal", () => {
  it("throws integrity_failed for a non-database file", () => {
    const f = path.join(root, "junk.db");
    fs.writeFileSync(f, "not a database at all, just text".repeat(50));
    expect(() => verifySnapshot(f)).toThrow(/integrity_failed/);
  });

  it("lists only secrets-YYYYMMDD.db files", () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ["secrets-20261020.db", "secrets-2026102.db", "secrets-20261020.db-wal", "other.db", INFLIGHT]) {
      fs.writeFileSync(path.join(dir, n), "");
    }
    expect(listLocal(dir)).toEqual([{ name: "secrets-20261020.db", slot: "20261020" }]);
    expect(listLocal(path.join(root, "absent"))).toEqual([]);
  });
});
