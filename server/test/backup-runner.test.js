import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { parseBackupSettings } from "../src/config.js";
import { createBackupRunner, pushKuma, redact } from "../src/backup/runner.js";
import { BackupError } from "../src/backup/errors.js";
import { shiftSlot } from "../src/backup/schedule.js";
import { Database } from "../src/database.js";

const TOKEN = "github_pat_RUNNERSECRET_abcdef";
const PUSH = "https://kuma.example/api/push/PUSHSECRET";
const SLOT = "20261020";
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");
let RECIPIENT;

beforeAll(async () => {
  RECIPIENT = await identityToRecipient(await generateIdentity());
});

// ── fake GitHub + Kuma ─────────────────────────────────────────────────────
function fakeServer() {
  const s = {
    assets: [],
    calls: [],
    kuma: [],
    nextId: 1000,
    override: null, // (label, url, init) => Response | undefined
    expiration: null,
  };
  const json = (b, status = 200) => {
    const headers = { "content-type": "application/json" };
    if (s.expiration) headers["github-authentication-token-expiration"] = s.expiration;
    return new Response(JSON.stringify(b), { status, headers });
  };
  s.addGood = (slot, extra = {}) => {
    const hex = sha(Buffer.from(slot));
    const a = {
      id: s.nextId++,
      name: `secrets-${slot}.db.gz.age`,
      state: "uploaded",
      label: `sha256-${hex}`,
      digest: `sha256:${hex}`,
      size: slot.length,
      ...extra,
    };
    s.assets.push(a);
    return a;
  };
  s.signals = [];
  s.fetch = async (url, init = {}) => {
    s.signals.push(init.signal);
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.host === "kuma.example") {
      s.kuma.push({ status: u.searchParams.get("status"), msg: u.searchParams.get("msg") });
      s.calls.push(`KUMA ${u.searchParams.get("status")}`);
      const o = s.override?.(`KUMA ${u.searchParams.get("status")}`, url, init);
      if (o) return typeof o === "function" ? o() : o;
      return new Response("ok", { status: 200 });
    }
    let label;
    if (u.pathname.endsWith("/releases/tags/daily")) label = "GET tag";
    else if (/\/releases\/42\/assets$/.test(u.pathname) && u.host === "uploads.github.com") label = "POST upload";
    else if (/\/releases\/42\/assets$/.test(u.pathname)) label = "GET list";
    else if (/\/releases\/assets\/\d+$/.test(u.pathname)) label = `${method} asset`;
    else if (u.host === "objects.example") label = "GET download";
    else label = `${method} ${u.pathname}`;
    s.calls.push(label);
    const o = s.override?.(label, url, init);
    if (o) {
      if (typeof o === "function") return o();
      return o;
    }
    if (label === "GET tag") return json({ id: 42 });
    if (label === "GET list") return json(s.assets);
    if (label === "POST upload") {
      const body = Buffer.from(init.body);
      const hex = sha(body);
      const a = {
        id: s.nextId++,
        name: u.searchParams.get("name"),
        label: u.searchParams.get("label"),
        state: "uploaded",
        size: body.length,
        digest: `sha256:${hex}`,
      };
      s.assets.push(a);
      return json(a, 201);
    }
    const id = Number(u.pathname.split("/").pop());
    const a = s.assets.find((x) => x.id === id);
    if (label === "DELETE asset") {
      s.assets = s.assets.filter((x) => x.id !== id);
      return new Response(null, { status: 204 });
    }
    if (label === "GET asset") return a ? json(a) : json({ message: "Not Found" }, 404);
    return json({ message: "unexpected" }, 418);
  };
  return s;
}

// ── harness ────────────────────────────────────────────────────────────────
let root;
let dir;
let snapFile;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-20T22:30:00Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sm-runner-"));
  dir = path.join(root, "backups");
  fs.mkdirSync(dir);
  snapFile = path.join(root, "snap.db");
  fs.writeFileSync(snapFile, Buffer.alloc(50_000, 3));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function env(extra = {}) {
  return {
    NODE_ENV: "production",
    SECRET_MANAGER_BACKUP_DIR: dir,
    SECRET_MANAGER_BACKUP_AGE_RECIPIENT: RECIPIENT,
    SECRET_MANAGER_BACKUP_GITHUB_REPO: "someone/vault-backups",
    SECRET_MANAGER_BACKUP_GITHUB_TOKEN: TOKEN,
    SECRET_MANAGER_BACKUP_PUSH_URL: PUSH,
    ...extra,
  };
}

function make({ envOverrides = {}, envRaw = null, snapshot = null, fetchImpl = null, db: realDb = null } = {}) {
  const server = fakeServer();
  const audits = [];
  const lines = [];
  const push = (...a) => lines.push(a.join(" "));
  const log = { info: push, warn: push, error: push };
  const snapCalls = [];
  const defaultSnapshot = async (_db, opts) => {
    snapCalls.push(opts.slot);
    opts.guard();
    return { file: snapFile, reused: false, counts: { secrets: 3, tokens: 2 }, bytes: 50_000, notes: [] };
  };
  const settings = {
    dbPath: path.join(root, "secrets.db"),
    backup: parseBackupSettings(envRaw ?? env(envOverrides)),
  };
  const db = realDb ?? { insertAuditLog: (row) => audits.push({ ...row, details: JSON.parse(row.details) }) };
  const runner = createBackupRunner({
    db,
    settings,
    fetchImpl: fetchImpl ?? server.fetch,
    log,
    snapshot: snapshot ?? defaultSnapshot,
  });
  return { runner, server, audits, lines, snapCalls, settings };
}

// Advance fake time in small steps while letting real I/O (fs, zlib) run.
async function settle(p, stepMs = 250, max = 2000) {
  let done = false;
  p.then(() => (done = true));
  for (let i = 0; i < max && !done; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (!done) await vi.advanceTimersByTimeAsync(stepMs);
  }
  return p;
}

async function advance(ms, runner) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle(runner.idle(), 1, 4000);
}

function expectClean(lines, audits) {
  const all = lines.join("\n") + JSON.stringify(audits);
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain(PUSH);
  expect(all).not.toContain("PUSHSECRET");
}

// ── tests ──────────────────────────────────────────────────────────────────
describe("runSlot", () => {
  it("happy path: release → list → upload → list → delete old → Kuma up", async () => {
    const h = make();
    for (let i = 1; i <= 31; i += 1) h.server.addGood(shiftSlot(SLOT, -i));
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.calls).toEqual([
      "GET tag",
      "GET list",
      "POST upload",
      "GET list",
      "DELETE asset",
      "KUMA up",
    ]);
    expect(h.server.kuma).toEqual([{ status: "up", msg: "OK" }]);
    expect(h.audits).toHaveLength(1);
    const a = h.audits[0];
    expect(a).toMatchObject({ tokenName: "system:backup", action: "backup", keyName: SLOT, status: "success", ipAddress: null });
    expect(a.details).toMatchObject({ trigger: "scheduled", attempt: 1, stage: "done", reconciled: false, secrets: 3, tokens: 2, plain_bytes: 50_000 });
    expect(typeof a.details.max_loop_delay_ms).toBe("number");
    expect(a.details.cipher_bytes).toBeGreaterThan(0);
    expect(h.server.assets.some((x) => x.name === `secrets-${SLOT}.db.gz.age`)).toBe(true);
    expectClean(h.lines, h.audits);
  });

  it("local-only mode makes no fetch call", async () => {
    const h = make({ envRaw: { NODE_ENV: "production", SECRET_MANAGER_BACKUP_DIR: dir } });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.calls).toEqual([]);
    expect(h.audits[0].details.stage).toBe("local_only");
  });

  it("nonprod gate: zero fetch calls, Kuma included", async () => {
    const e = env();
    delete e.NODE_ENV;
    const h = make({ envRaw: e });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.calls).toEqual([]);
  });

  it("off-site config_invalid: local snapshot + rotation, then Kuma down, no retry", async () => {
    const old = path.join(dir, "secrets-20250101.db");
    fs.writeFileSync(old, "");
    for (let i = 0; i < 14; i += 1) fs.writeFileSync(path.join(dir, `secrets-${shiftSlot(SLOT, -i)}.db`), "");
    const h = make({ envOverrides: { SECRET_MANAGER_BACKUP_GITHUB_REPO: "bad" } });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "config_invalid", final: true });
    expect(h.snapCalls).toEqual([SLOT]);
    expect(fs.existsSync(old)).toBe(false);
    expect(h.server.calls).toEqual(["KUMA down"]);
    expect(h.server.kuma).toEqual([{ status: "down", msg: "config_invalid" }]);
    expect(h.audits[0].status).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("localErrors only: uploads and verifies, then config_invalid down, no retry", async () => {
    const h = make({ envOverrides: { SECRET_MANAGER_BACKUP_UTC_TIME: "25:99" } });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "config_invalid", final: true });
    expect(h.server.calls).toContain("POST upload");
    expect(h.server.kuma).toEqual([{ status: "down", msg: "config_invalid" }]);
    expect(h.audits[0].details.stage).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abandoned run makes no fs, fetch, audit or Kuma call after release", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = make({
      snapshot: async (_db, opts) => {
        await gate;
        opts.guard();
        fs.writeFileSync(path.join(dir, "late-write"), "x");
        return { file: snapFile, reused: false, counts: { secrets: 1, tokens: 1 }, bytes: 1, notes: [] };
      },
    });
    const p = h.runner.trigger(SLOT, "scheduled");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const res = await p;
    expect(res.code).toBe("timeout");
    const calls = h.server.calls.length;
    const audits = h.audits.length;
    release();
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.server.calls.length).toBe(calls);
    expect(h.audits.length).toBe(audits);
    expect(fs.existsSync(path.join(dir, "late-write"))).toBe(false);
  });

  it("a rejected snapshot means no local deletions and no fetch", async () => {
    const old = path.join(dir, "secrets-20200101.db");
    fs.writeFileSync(old, "");
    const h = make({
      snapshot: async () => {
        throw new BackupError("disk_low");
      },
    });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "disk_low", final: false });
    expect(fs.existsSync(old)).toBe(true);
    expect(h.server.calls).toEqual([]);
  });

  it("crash recovery: a good asset for the slot means no upload, Kuma up", async () => {
    const h = make();
    h.server.addGood(SLOT);
    const res = await settle(h.runner.trigger(SLOT, "catchup"));
    expect(res.status).toBe("success");
    expect(h.server.calls).not.toContain("POST upload");
    expect(h.server.kuma).toEqual([{ status: "up", msg: "OK" }]);
    expect(h.audits[0].details.reconciled).toBe(true);
  });

  it("reconcile with a null digest and a failing download: no DELETE, github_network, retry", async () => {
    const h = make();
    h.server.addGood(SLOT, { digest: null });
    h.server.override = (label, url, init) => {
      if (label === "GET asset" && init.headers.Accept === "application/octet-stream") {
        return new Response(null, { status: 302, headers: { location: "https://objects.example/x?sig=1" } });
      }
      if (label === "GET download") {
        return () => {
          throw new TypeError("fetch failed");
        };
      }
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "github_network", final: false });
    expect(h.server.calls).not.toContain("DELETE asset");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reconcile verify_mismatch → DELETE, then upload", async () => {
    const h = make();
    h.server.addGood(SLOT, { digest: null });
    h.server.override = (label, url, init) => {
      if (label === "GET asset" && init.headers.Accept === "application/octet-stream") {
        return new Response(Buffer.from("different bytes"), { status: 200 });
      }
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    const i = h.server.calls.indexOf("DELETE asset");
    expect(i).toBeGreaterThan(-1);
    expect(h.server.calls.indexOf("POST upload")).toBeGreaterThan(i);
  });

  it("a starter asset for the slot is deleted, then uploaded", async () => {
    const h = make();
    h.server.addGood(SLOT, { state: "starter", label: null, digest: null });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.calls.slice(0, 4)).toEqual(["GET tag", "GET list", "DELETE asset", "POST upload"]);
  });

  it("a label-less uploaded asset for the slot → slot_asset_foreign, no DELETE, no retry", async () => {
    const h = make();
    h.server.addGood(SLOT, { label: null });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "slot_asset_foreign", final: true });
    expect(h.server.calls).not.toContain("DELETE asset");
    expect(h.server.kuma).toEqual([{ status: "down", msg: "slot_asset_foreign" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a post-upload verify_mismatch is retried", async () => {
    const h = make();
    h.server.override = (label) => {
      if (label === "POST upload") {
        return new Response(
          JSON.stringify({ id: 5, name: `secrets-${SLOT}.db.gz.age`, state: "uploaded", size: 1, label: "x", digest: null }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ code: "verify_mismatch", final: false });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("422 on upload → re-list once → verified → success", async () => {
    const h = make();
    let first = true;
    h.server.override = (label, url, init) => {
      if (label === "POST upload" && first) {
        first = false;
        const body = Buffer.from(init.body);
        h.server.assets.push({
          id: 77,
          name: `secrets-${SLOT}.db.gz.age`,
          state: "uploaded",
          label: `sha256-${sha(body)}`,
          digest: `sha256:${sha(body)}`,
          size: body.length,
        });
        return new Response(JSON.stringify({ message: "already_exists" }), { status: 422 });
      }
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.calls.filter((c) => c === "POST upload")).toHaveLength(1);
    expect(h.audits[0].details.reconciled).toBe(true);
  });

  it("a retention delete failure still succeeds with note retention_failed", async () => {
    const h = make();
    for (let i = 1; i <= 31; i += 1) h.server.addGood(shiftSlot(SLOT, -i));
    h.server.override = (label) =>
      label === "DELETE asset" ? new Response("{}", { status: 500 }) : undefined;
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.status).toBe("success");
    expect(h.server.kuma).toEqual([{ status: "up", msg: "OK" }]);
    expect(h.audits[0].details.notes).toContain("retention_failed");
  });

  it("token expiring in 3 days: uploaded, audit success, Kuma down token_expiring, no retry", async () => {
    const h = make();
    h.server.expiration = "2026-10-23 22:30:00 UTC";
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "success", code: "token_expiring" });
    expect(h.server.calls).toContain("POST upload");
    expect(h.server.kuma).toEqual([{ status: "down", msg: "token_expiring" }]);
    expect(h.audits[0].status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serialises: same slot deduped, another slot queued in order", async () => {
    const h = make();
    const a = h.runner.trigger(SLOT, "scheduled");
    const b = h.runner.trigger(SLOT, "catchup");
    expect(b).toBe(a);
    const prev = shiftSlot(SLOT, -1);
    const c = h.runner.trigger(prev, "retry");
    await settle(Promise.all([a, c]));
    expect(h.snapCalls).toEqual([SLOT, prev]);
    expect(h.server.calls.filter((x) => x === "POST upload")).toHaveLength(2);
    expect(h.audits.map((x) => x.keyName)).toEqual([SLOT, prev]);
  });

  it("local-only with a mistyped local key: audit error config_invalid, no fetch", async () => {
    const h = make({ envRaw: { NODE_ENV: "production", SECRET_MANAGER_BACKUP_DIR: dir, SECRET_MANAGER_BACKUP_KEEP_DAYS: "x" } });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "config_invalid", final: true });
    expect(h.snapCalls).toEqual([SLOT]);
    expect(h.server.calls).toEqual([]);
    expect(h.audits[0].details.stage).toBe("local_only");
  });

  it("an abandoned run in the off-site stage aborts its fetch and makes no further call", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const h = make();
    h.server.override = (label) => {
      if (label === "GET list") {
        return async () => {
          await gate;
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        };
      }
      return undefined;
    };
    const p = h.runner.trigger(SLOT, "scheduled");
    await settle(new Promise((r) => setTimeout(r, 1000)), 100, 50);
    expect(h.server.calls).toEqual(["GET tag", "GET list"]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const res = await p;
    expect(res.code).toBe("timeout");
    expect(h.server.signals[1].aborted).toBe(true);
    const calls = h.server.calls.length;
    release();
    await settle(new Promise((r) => setTimeout(r, 5000)), 100, 100);
    expect(h.server.calls.length).toBe(calls);
    expect(h.server.calls).not.toContain("POST upload");
    expect(h.server.calls).not.toContain("DELETE asset");
  });

  it("writes a real audit row through Database", async () => {
    const realDb = new Database(path.join(root, "audit.db"));
    try {
      const h = make({ db: realDb });
      await settle(h.runner.trigger(SLOT, "scheduled"));
      const row = realDb.db
        .prepare("SELECT token_name, action, key_name, status, ip_address, details FROM audit_logs")
        .get();
      expect(row).toMatchObject({ token_name: "system:backup", action: "backup", key_name: SLOT, status: "success", ip_address: null });
      expect(JSON.parse(row.details).stage).toBe("done");
      expect(row.details).not.toContain(TOKEN);
    } finally {
      realDb.db.close();
    }
  });

  it("a DB above the off-site ceiling fails db_too_large before any GitHub call", async () => {
    const h = make({
      snapshot: async (_db, opts) => {
        opts.guard();
        return { file: snapFile, reused: false, counts: { secrets: 1, tokens: 1 }, bytes: 32 * 1024 * 1024 + 1, notes: ["large_db"] };
      },
    });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res).toMatchObject({ status: "error", code: "db_too_large", final: true });
    expect(h.audits[0].details).toMatchObject({ stage: "offsite", notes: ["large_db"] });
    expect(h.server.calls).toEqual(["KUMA down"]);
    expect(h.server.kuma).toEqual([{ status: "down", msg: "db_too_large" }]);
  });

  it("an unreadable snapshot during encryption maps to local_failed, not internal", async () => {
    const h = make({
      snapshot: async () => ({ file: path.join(root, "gone.db"), reused: true, counts: { secrets: 1, tokens: 1 }, bytes: 10, notes: [] }),
    });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.code).toBe("local_failed");
    expect(h.server.calls).not.toContain("POST upload");
  });

  it("a post-upload verify_mismatch deletes our own asset before retrying", async () => {
    const h = make();
    h.server.override = (label) => {
      if (label === "POST upload") {
        h.server.assets.push({ id: 5, name: `secrets-${SLOT}.db.gz.age`, state: "uploaded", size: 1, label: "x", digest: null });
        return new Response(
          JSON.stringify({ id: 5, name: `secrets-${SLOT}.db.gz.age`, state: "uploaded", size: 1, label: "x", digest: null }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.code).toBe("verify_mismatch");
    expect(h.server.calls.slice(-1)).toEqual(["DELETE asset"]);
    expect(h.server.assets.some((a) => a.id === 5)).toBe(false);
  });

  it("retries of two different slots are independent", async () => {
    const h = make({
      snapshot: async (_db, opts) => {
        h.snapCalls.push(opts.slot);
        throw new BackupError("github_5xx");
      },
    });
    const prev = shiftSlot(SLOT, -1);
    await settle(h.runner.trigger(prev, "catchup"));
    await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await settle(h.runner.idle(), 1, 100);
    expect(h.snapCalls.filter((x) => x === prev)).toHaveLength(2);
    expect(h.snapCalls.filter((x) => x === SLOT)).toHaveLength(2);
    h.runner.stop();
    expect(vi.getTimerCount()).toBe(0); // every per-slot retry timer cleared
  });

  it("a success through another trigger cancels that slot's pending retry", async () => {
    let fail = true;
    const h = make({
      snapshot: async (_db, opts) => {
        h.snapCalls.push(opts.slot);
        if (fail) throw new BackupError("github_5xx");
        return { file: snapFile, reused: false, counts: { secrets: 1, tokens: 1 }, bytes: 1, notes: [] };
      },
    });
    await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(vi.getTimerCount()).toBe(1);
    fail = false;
    await settle(h.runner.trigger(SLOT, "catchup"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.snapCalls).toHaveLength(2);
    h.runner.stop();
  });

  it("a final failure through another trigger cancels that slot's pending retry", async () => {
    let call = 0;
    const h = make({
      snapshot: async (_db, opts) => {
        h.snapCalls.push(opts.slot);
        call += 1;
        throw new BackupError(call === 1 ? "github_5xx" : "slot_asset_foreign");
      },
    });
    await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(vi.getTimerCount()).toBe(1);
    const res = await settle(h.runner.trigger(SLOT, "catchup"));
    expect(res).toMatchObject({ code: "slot_asset_foreign", final: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.snapCalls).toHaveLength(2);
    h.runner.stop();
  });

  it("a failed cleanup of a mismatched upload is logged with its code only", async () => {
    const h = make();
    h.server.override = (label) => {
      if (label === "POST upload") {
        return new Response(
          JSON.stringify({ id: 5, name: `secrets-${SLOT}.db.gz.age`, state: "uploaded", size: 1, label: "x", digest: null }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (label === "DELETE asset") return new Response(JSON.stringify({ message: `nope ${TOKEN}` }), { status: 500 });
      return undefined;
    };
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.code).toBe("verify_mismatch");
    expect(h.lines.join("\n")).toContain("cleanup of a mismatched upload failed: github_5xx");
    expectClean(h.lines, h.audits);
  });

  it("a plain Error from the snapshot maps to internal", async () => {
    const h = make({
      snapshot: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
    });
    const res = await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(res.code).toBe("internal");
    expect(h.lines.join("\n")).toContain("internal error: Error");
    expectClean(h.lines, h.audits);
  });

  it("after a final failure the next attempt starts at 1 again", async () => {
    const h = make({ envOverrides: { SECRET_MANAGER_BACKUP_GITHUB_REPO: "bad" } });
    await settle(h.runner.trigger(SLOT, "scheduled"));
    await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(h.audits.map((a) => a.details.attempt)).toEqual([1, 1]);
  });

  it("a fetch that always rejects never produces an unhandled rejection", async () => {
    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    try {
      const h = make({
        fetchImpl: async () => {
          throw new TypeError("network down");
        },
      });
      const res = await settle(h.runner.trigger(SLOT, "scheduled"));
      expect(res.code).toBe("github_network");
      expect(h.server.kuma).toEqual([]);
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", spy);
    }
  });
});

describe("timers", () => {
  it("upload 502 ×3: attempts at T, T+15, T+45, then down; no retention DELETE", async () => {
    vi.setSystemTime(new Date("2026-10-20T20:00:00Z"));
    const h = make();
    const times = [];
    h.server.override = (label, url) => {
      if (label === "POST upload" && url.includes(SLOT)) {
        times.push(new Date().toISOString().slice(11, 16));
        return new Response("{}", { status: 502 });
      }
      return undefined;
    };
    h.runner.start();
    await advance(2.5 * 3600_000, h.runner); // 22:30
    await advance(15 * 60_000, h.runner); // 22:45
    await advance(30 * 60_000, h.runner); // 23:15
    const rows = h.audits.filter((a) => a.keyName === SLOT);
    expect(rows.map((r) => r.details.trigger)).toEqual(["scheduled", "retry", "retry"]);
    expect(times).toEqual(["22:30", "22:45", "23:15"]);
    expect(h.server.kuma.at(-1)).toEqual({ status: "down", msg: "github_5xx" });
    expect(h.server.calls).not.toContain("DELETE asset");
    expect(vi.getTimerCount()).toBe(1); // next slot timer only
    h.runner.stop();
  });

  it("a catch-up failure counts as attempt 1", async () => {
    vi.setSystemTime(new Date("2026-10-20T22:31:00Z"));
    const times = [];
    const h = make({
      snapshot: async () => {
        times.push(new Date().toISOString().slice(11, 16));
        throw new BackupError("github_5xx");
      },
    });
    h.runner.start();
    await advance(120_000, h.runner); // 22:33
    await advance(15 * 60_000, h.runner); // 22:48
    await advance(30 * 60_000, h.runner); // 23:18
    expect(times).toEqual(["22:33", "22:48", "23:18"]);
    expect(h.audits.map((a) => [a.details.trigger, a.details.attempt])).toEqual([
      ["catchup", 1],
      ["retry", 2],
      ["retry", 3],
    ]);
    expect(h.server.kuma).toEqual([{ status: "down", msg: "github_5xx" }]);
    h.runner.stop();
  });

  it("off-site config error with the slot file present: catch-up still runs and pages", async () => {
    fs.writeFileSync(path.join(dir, `secrets-${SLOT}.db`), "");
    vi.setSystemTime(new Date("2026-10-20T23:00:00Z"));
    const h = make({ envOverrides: { SECRET_MANAGER_BACKUP_GITHUB_TOKEN: "" , SECRET_MANAGER_BACKUP_GITHUB_REPO: "x" } });
    h.runner.start();
    await advance(120_000, h.runner);
    expect(h.server.kuma).toEqual([{ status: "down", msg: "config_invalid" }]);
    h.runner.stop();
  });

  it("true local-only with the slot file present: catch-up skipped", async () => {
    fs.writeFileSync(path.join(dir, `secrets-${SLOT}.db`), "");
    vi.setSystemTime(new Date("2026-10-20T23:00:00Z"));
    const h = make({ envRaw: { NODE_ENV: "production", SECRET_MANAGER_BACKUP_DIR: dir } });
    h.runner.start();
    await advance(120_000, h.runner);
    expect(h.snapCalls).toEqual([]);
    h.runner.stop();
  });

  it("bad UTC_TIME still schedules at 22:30 (no NaN timer)", async () => {
    vi.setSystemTime(new Date("2026-10-20T22:00:00Z"));
    const h = make({ envRaw: { NODE_ENV: "production", SECRET_MANAGER_BACKUP_DIR: dir, SECRET_MANAGER_BACKUP_UTC_TIME: "nope" } });
    h.runner.start();
    await advance(29 * 60_000, h.runner); // 22:29 (catch-up for 1019 ran at 22:02)
    expect(h.snapCalls).toEqual(["20261019"]);
    await advance(60_000, h.runner); // 22:30
    expect(h.snapCalls).toEqual(["20261019", SLOT]);
    h.runner.stop();
  });

  it("a never-settling snapshot times out after 20 min; the next slot still runs", async () => {
    vi.setSystemTime(new Date("2026-10-20T22:29:00Z"));
    const slots = [];
    const h = make({
      snapshot: (_db, opts) => {
        slots.push(opts.slot);
        return new Promise(() => {});
      },
    });
    h.runner.start();
    await vi.advanceTimersByTimeAsync(60_000); // 22:30 scheduled run hangs
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(h.audits[0]?.details.trigger).toBe("scheduled");
    expect(h.audits.find((a) => a.details.code === "timeout")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(slots).toContain("20261021");
    h.runner.stop();
  });

  it("catch-up target is computed at fire time", async () => {
    vi.setSystemTime(new Date("2026-10-20T22:29:00Z"));
    const h = make();
    h.runner.start();
    await advance(60_000, h.runner); // 22:30 scheduled run completes
    await advance(60_000, h.runner); // 22:31 catch-up: target computed now, not at boot (20261019)
    const catchups = h.audits.filter((a) => a.details.trigger === "catchup");
    expect(catchups.map((a) => a.keyName)).toEqual([SLOT]);
    expect(catchups[0].details.reconciled).toBe(true);
    expect(catchups[0].details.attempt).toBe(1); // attempts cleared after the success
    expect(h.server.calls.filter((c) => c === "POST upload")).toHaveLength(1);
    h.runner.stop();
  });

  it("an early timer fire (clock moved back) re-arms without running", async () => {
    vi.useRealTimers();
    let clock = new Date("2026-10-20T22:00:00Z");
    const timers = [];
    const h0 = make();
    const runner = createBackupRunner({
      db: { insertAuditLog() {} },
      settings: h0.settings,
      now: () => clock,
      fetchImpl: h0.server.fetch,
      log: { info() {}, warn() {}, error() {} },
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => {},
      snapshot: async () => {
        throw new Error("must not run");
      },
    });
    runner.start();
    const slotTimer = timers.find((t) => t.ms === 30 * 60_000);
    expect(slotTimer).toBeTruthy();
    clock = new Date("2026-10-20T21:00:00Z"); // moved back
    const before = timers.length;
    slotTimer.fn();
    await new Promise((r) => setImmediate(r));
    expect(timers.length).toBe(before + 1);
    expect(timers.at(-1).ms).toBe(90 * 60_000);
    runner.stop();
  });

  it("Kuma up fails twice → re-sent at +1 and +5 min, backup not re-run", async () => {
    const h = make();
    let kumaFails = 2;
    h.server.override = (label) => {
      if (label === "KUMA up" && kumaFails > 0) {
        kumaFails -= 1;
        return new Response("no", { status: 500 });
      }
      return undefined;
    };
    await settle(h.runner.trigger(SLOT, "scheduled"));
    expect(h.audits[0].details.notes).toContain("kuma_failed");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.server.kuma).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); // +1 min
    expect(h.server.kuma).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // +5 min
    expect(h.server.kuma).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(h.server.kuma).toHaveLength(3);
    expect(h.server.calls.filter((c) => c === "POST upload")).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("a later down push cancels a pending up re-send", async () => {
    const h = make();
    h.server.override = (label) => (label === "KUMA up" ? new Response("no", { status: 500 }) : undefined);
    await settle(h.runner.trigger(shiftSlot(SLOT, -1), "catchup"));
    expect(vi.getTimerCount()).toBe(1); // the +1 min "up" re-send is pending
    h.server.addGood(SLOT, { label: null }); // slot_asset_foreign: final at once
    h.server.override = null;
    const res = await settle(h.runner.trigger(SLOT, "scheduled"), 1, 200);
    expect(res).toMatchObject({ code: "slot_asset_foreign", final: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.server.kuma).toEqual([
      { status: "up", msg: "OK" },
      { status: "down", msg: "slot_asset_foreign" },
    ]);
    h.runner.stop();
  });

  it("start() removes a leftover .inflight.tmp even when the slot file exists", () => {
    fs.writeFileSync(path.join(dir, `secrets-${SLOT}.db`), "");
    fs.writeFileSync(path.join(dir, ".inflight.tmp"), "x");
    fs.writeFileSync(path.join(dir, ".inflight.tmp-wal"), "x");
    const h = make();
    h.runner.start();
    expect(fs.readdirSync(dir)).toEqual([`secrets-${SLOT}.db`]);
    h.runner.stop();
  });

  it("stop() mid-run: no audit after stop, no further fetch", async () => {
    vi.setSystemTime(new Date("2026-10-20T22:29:00Z"));
    let release;
    const gate = new Promise((r) => (release = r));
    const h = make({
      snapshot: async (_db, opts) => {
        await gate;
        opts.guard();
        return { file: snapFile, reused: false, counts: { secrets: 1, tokens: 1 }, bytes: 1, notes: [] };
      },
    });
    h.runner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    h.runner.stop();
    release();
    await vi.advanceTimersByTimeAsync(48 * 3600_000);
    await new Promise((r) => setImmediate(r));
    expect(h.audits).toEqual([]);
    expect(h.server.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("helpers", () => {
  it("pushKuma overwrites status/msg/ping instead of appending", async () => {
    const urls = [];
    const ok = await pushKuma(
      "https://kuma.example/api/push/X?status=up&msg=OK&ping=",
      "down",
      "github_5xx",
      async (u) => {
        urls.push(u);
        return new Response("ok");
      },
      console,
    );
    expect(ok).toBe(true);
    const u = new URL(urls[0]);
    expect(u.searchParams.getAll("status")).toEqual(["down"]);
    expect(u.searchParams.getAll("msg")).toEqual(["github_5xx"]);
    expect(u.searchParams.getAll("ping")).toEqual([""]);
  });

  it("pushKuma logs only a status or error code, never the URL", async () => {
    const lines = [];
    const log = { error: (m) => lines.push(m) };
    expect(await pushKuma(PUSH, "up", "OK", async () => new Response("", { status: 503 }), log)).toBe(false);
    expect(
      await pushKuma(
        PUSH,
        "up",
        "OK",
        async () => {
          throw new TypeError(`fetch failed ${PUSH}`, { cause: { code: "ECONNREFUSED" } });
        },
        log,
      ),
    ).toBe(false);
    expect(lines).toEqual(["backup: kuma push failed: 503", "backup: kuma push failed: ECONNREFUSED"]);
  });

  it("redact replaces each secret", () => {
    expect(redact(`a ${TOKEN} b /api/push/PUSHSECRET`, [TOKEN, "/api/push/PUSHSECRET", null])).toBe(
      "a [redacted] b [redacted]",
    );
  });
});
