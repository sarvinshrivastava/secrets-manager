// Local snapshot of the live vault DB: online backup on the app's own
// connection → verify → atomic rename. One file per slot, so a retry or a
// boot catch-up reuses the verified file instead of taking a second copy.
import fs from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { BackupError, isDiskFull, toBackupError } from "./errors.js";

export const LOCAL_RE = /^secrets-(\d{8})\.db$/;
export const INFLIGHT = ".inflight.tmp";
export const LARGE_DB_BYTES = 64 * 1024 * 1024;

const noop = () => {};

function sizeOrZero(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// rm -f the temp file and every SQLite sidecar it may have grown.
export function cleanInflight(dir) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(path.join(dir, INFLIGHT + suffix), { force: true });
  }
}

// Needs room for the copy plus slack: 2 × (db + wal).
export function checkFreeSpace(dir, dbPath, statfs = fs.statfsSync) {
  const need = 2 * (sizeOrZero(dbPath) + sizeOrZero(`${dbPath}-wal`));
  const st = statfs(dir);
  if (Number(st.bavail) * Number(st.bsize) < need) {
    throw new BackupError("disk_low");
  }
}

// Opens the copy with its own handle, makes it self-contained (rollback
// journal, no -wal/-shm), checks integrity and counts rows.
export function verifySnapshot(file) {
  let handle;
  try {
    handle = new DatabaseDriver(file, { fileMustExist: true });
    handle.pragma("journal_mode = DELETE");
    const check = handle.pragma("integrity_check");
    if (check.length !== 1 || check[0].integrity_check !== "ok") {
      throw new BackupError("integrity_failed");
    }
    const count = (table) =>
      handle.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    return { secrets: count("secrets"), tokens: count("tokens") };
  } catch (err) {
    if (err instanceof BackupError) throw err;
    if (isDiskFull(err)) {
      throw new BackupError("disk_low", { cause: err });
    }
    throw new BackupError("integrity_failed", { cause: err });
  } finally {
    try {
      handle?.close();
    } catch {
      /* already closed */
    }
  }
}

function fsyncPath(p, flags) {
  const fd = fs.openSync(p, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// `guard` is called before every mutation; it throws when the run was
// abandoned (deadline or shutdown), so a late run never touches the disk.
export async function ensureLocalSnapshot(
  db,
  {
    dir,
    slot,
    dbPath,
    statfs = fs.statfsSync,
    sizeOf = sizeOrZero,
    guard = noop,
  },
) {
  const file = path.join(dir, `secrets-${slot}.db`);
  const tmp = path.join(dir, INFLIGHT);
  const notes = sizeOf(dbPath) > LARGE_DB_BYTES ? ["large_db"] : [];
  let stage = "local";
  try {
    guard();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    if (fs.existsSync(file)) {
      try {
        const counts = verifySnapshot(file);
        return { file, reused: true, counts, bytes: sizeOrZero(file), notes };
      } catch (err) {
        if (err.code !== "integrity_failed") throw err;
        guard();
        fs.rmSync(file, { force: true });
      }
    }

    guard();
    cleanInflight(dir);
    checkFreeSpace(dir, dbPath, statfs);
    guard();
    // Pre-create 0600: SQLite treats a 0-byte file as an empty DB and the
    // backup overwrites it in place, so the mode is kept (umask-proof).
    fs.closeSync(fs.openSync(tmp, "wx", 0o600));
    stage = "snapshot";
    await db.db.backup(tmp);
    stage = "local";
    guard();
    fs.chmodSync(tmp, 0o600);
    const counts = verifySnapshot(tmp);
    fsyncPath(tmp, "r+");
    guard();
    fs.renameSync(tmp, file);
    fsyncPath(dir, "r");
    return { file, reused: false, counts, bytes: sizeOrZero(file), notes };
  } catch (err) {
    // A failed or abandoned run must not leave a half-written temp file.
    // When abandoned, the next run's cleanInflight removes it instead.
    if (err?.code !== "timeout") {
      try {
        cleanInflight(dir);
      } catch {
        /* best effort */
      }
    }
    throw toBackupError(err, stage);
  }
}

export function listLocal(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: LOCAL_RE.exec(name) }))
    .filter((x) => x.m)
    .map(({ name, m }) => ({ name, slot: m[1] }));
}
