import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { cryptoManager, addToken, bearer } from "./helpers.js";
import { Database } from "../src/database.js";
import { RateLimiter } from "../src/rate-limit.js";
import { createApp } from "../src/app.js";

// All timestamps are pinned: the app is built over an injected clock (UTC).
// 2030 keeps the real-time audit rows written by HTTP calls far outside every
// window, so they never leak into the counts.
const NOW = "2030-06-15T10:30:00.000Z";
const clock = { ms: Date.parse(NOW) };

let dbPath;
let db;
let app;
let admin;
let scoped;
let reader;

function build(retentionDays = 90, extra = {}) {
  dbPath = path.join(
    os.tmpdir(),
    `sm-analytics-${nodeCrypto.randomBytes(8).toString("hex")}.db`,
  );
  db = new Database(dbPath);
  const settings = {
    publicRateLimitPerMinute: 10000,
    trustedProxyIps: ["127.0.0.1", "::1"],
    auditLogRetentionDays: retentionDays,
    analyticsCacheMs: 0, // seed-then-query tests must see fresh data
    now: () => clock.ms,
    ...extra,
  };
  app = createApp(
    settings,
    db,
    cryptoManager,
    new RateLimiter(10000, 60, { autoSweep: false }),
  );
  admin = addToken(db, { name: "admin", role: "write" });
  scoped = addToken(db, { name: "scopedw", role: "write", scope: "A" });
  reader = addToken(db, { name: "reader", role: "read" });
}

beforeEach(() => {
  clock.ms = Date.parse(NOW);
  build();
});
afterEach(() => {
  try {
    db.db.close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  vi.restoreAllMocks();
});

const get = (query = "", token = admin) =>
  request(app)
    .get(`/api/analytics${query}`)
    .set(token ? bearer(token) : {});
const audit = (ts, action, o = {}) =>
  db.db
    .prepare(
      "INSERT INTO audit_logs (timestamp, token_name, action, key_name, status, ip_address, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ts,
      o.token ?? null,
      action,
      o.key ?? null,
      o.status ?? "ok",
      "1.1.1.1",
      o.details ?? null,
    );
const secret = (folder, key, createdAt = "2030-01-01T00:00:00.000Z") =>
  db.db
    .prepare(
      "INSERT INTO secrets (key, folder, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(key, folder, Buffer.alloc(12), Buffer.alloc(16), createdAt);
const sum = (body, field) =>
  body.activity.points.reduce((n, p) => n + p[field], 0);
const unreadKeys = (body) =>
  body.unread.items.map((i) => `${i.folder}/${i.key}`);
const EVIDENCE_TS = "2030-06-12T12:00:00.000Z"; // inside the 7d window
const auditRows = (action) =>
  db.db
    .prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id ASC")
    .all(action);

describe("access and contract", () => {
  it("unscoped write token gets every panel (1)", async () => {
    secret("A", "K1");
    secret("B", "K2");
    secret("B", "K3");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.admin).toBe(true);
    expect(res.body.range).toBe("7d");
    expect(res.body.generated_at).toBe(NOW);
    expect(res.body.retention_days).toBe(90);
    expect(res.body.clamped).toBe(false);
    expect(res.body.secrets).toEqual({
      total: 3,
      folders: [
        { folder: "B", count: 2 },
        { folder: "A", count: 1 },
      ],
    });
    expect(res.body.tokens).not.toBeNull();
    expect(res.body.activity.bucket).toBe("day");
    expect(res.body.top_keys).toEqual([]);
    expect(res.body.top_tokens).toEqual([]);
    expect(res.body.unread.total).toBe(3);
  });

  it("scoped write token sees only its folders, nulls elsewhere, no authz row (2)", async () => {
    secret("A", "K1");
    secret("B", "K2");
    const res = await get("", scoped);
    expect(res.status).toBe(200);
    expect(res.body.admin).toBe(false);
    expect(res.body.secrets).toEqual({
      total: 1,
      folders: [{ folder: "A", count: 1 }],
    });
    for (const panel of [
      "tokens",
      "activity",
      "top_keys",
      "top_tokens",
      "unread",
    ]) {
      expect(res.body[panel]).toBeNull();
    }
    expect(auditRows("authz")).toHaveLength(0);
  });

  it("read token with scope * is not admin: all folders, nulls (3)", async () => {
    secret("A", "K1");
    secret("B", "K2");
    const res = await get("", reader);
    expect(res.status).toBe(200);
    expect(res.body.admin).toBe(false);
    expect(res.body.secrets.total).toBe(2);
    expect(res.body.secrets.folders).toHaveLength(2);
    expect(res.body.activity).toBeNull();
    expect(res.body.unread).toBeNull();
  });

  it("no token is 401 (4)", async () => {
    const res = await get("", null);
    expect(res.status).toBe(401);
  });

  it("range absent is 7d; unknown, empty and repeated are 400 (5)", async () => {
    const absent = await get();
    expect(absent.body.range).toBe("7d");
    expect(absent.body.activity.points).toHaveLength(7);
    for (const query of [
      "?range=1y",
      "?range=",
      "?range=7d&range=24h",
      "?range[a]=1",
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect(res.body).toEqual({ detail: "Invalid range" });
    }
  });

  it("the endpoint writes no audit row of its own", async () => {
    const before = db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get();
    await get("?range=30d");
    await get("", scoped);
    const after = db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get();
    expect(after.n).toBe(before.n);
  });

  it("empty vault returns [] lists and zero-filled points, never null (16)", async () => {
    const res = await get();
    expect(res.body.secrets).toEqual({ total: 0, folders: [] });
    expect(res.body.top_keys).toEqual([]);
    expect(res.body.top_tokens).toEqual([]);
    expect(res.body.unread).toEqual({ total: 0, items: [] });
    expect(res.body.activity.points.every((p) => p.reads === 0)).toBe(true);
  });
});

describe("time model", () => {
  it("24h window is bucket aligned and excludes the row before it (6)", async () => {
    audit("2030-06-14T09:45:00.000Z", "get_secret", {
      key: "K9",
      details: "folder=A",
    });
    audit("2030-06-14T12:00:00.000Z", "get_secret", {
      key: "KA",
      details: "folder=A",
    });
    audit("2030-06-15T10:15:00.000Z", "export_env", { details: "folders=A" });
    audit("2030-06-15T10:20:00.000Z", "get_secret", {
      key: "KA",
      details: "folder=A",
    });
    audit("2030-06-15T10:29:00.000Z", "get_secret", {
      key: "KB",
      details: "folder=A",
    });
    const res = await get("?range=24h");
    const { points, bucket } = res.body.activity;
    expect(bucket).toBe("hour");
    expect(points).toHaveLength(24);
    expect(points[0].t).toBe("2030-06-14T11:00:00.000Z");
    expect(points[23].t).toBe("2030-06-15T10:00:00.000Z");
    expect(res.body.since).toBe("2030-06-14T11:00:00.000Z");
    // points count ok get_secret + export_env; top_keys counts get_secret only
    expect(sum(res.body, "reads")).toBe(4);
    expect(res.body.top_keys).toEqual([
      { key: "KA", reads: 2 },
      { key: "KB", reads: 1 },
    ]);
    expect(res.body.top_keys.some((k) => k.key === "K9")).toBe(false);
    expect(res.body.top_keys.reduce((n, k) => n + k.reads, 0)).toBe(3);
  });

  it("7d, 30d and 90d give daily zero-filled points (7)", async () => {
    audit("2030-06-14T12:00:00.000Z", "get_secret", { key: "K" });
    for (const [range, n] of [
      ["7d", 7],
      ["30d", 30],
      ["90d", 90],
    ]) {
      const res = await get(`?range=${range}`);
      const { points } = res.body.activity;
      expect(points, range).toHaveLength(n);
      expect(points[n - 1].t).toBe("2030-06-15T00:00:00.000Z");
      expect(res.body.clamped).toBe(false);
      expect(sum(res.body, "reads")).toBe(1);
      expect(points.filter((p) => p.reads === 0)).toHaveLength(n - 1);
    }
    const week = await get("?range=7d");
    expect(week.body.activity.points[0].t).toBe("2030-06-09T00:00:00.000Z");
    expect(week.body.since).toBe("2030-06-09T00:00:00.000Z");
  });

  it("future-dated rows are excluded (8)", async () => {
    audit("2030-06-15T10:30:00.001Z", "get_secret", { key: "K" });
    audit("2030-06-16T00:00:00.000Z", "auth", { status: "failed" });
    audit(NOW, "get_secret", { key: "K" }); // exactly generated_at counts
    const res = await get();
    expect(sum(res.body, "reads")).toBe(1);
    expect(sum(res.body, "auth_failures")).toBe(0);
    expect(res.body.top_keys).toEqual([{ key: "K", reads: 1 }]);
  });

  it("retention shorter than range clamps the window (10)", async () => {
    build(3);
    audit("2030-06-12T12:00:00.000Z", "get_secret", { key: "K" }); // pruned era
    audit("2030-06-13T05:00:00.000Z", "get_secret", { key: "K" });
    const res = await get("?range=7d");
    expect(res.body.clamped).toBe(true);
    expect(res.body.retention_days).toBe(3);
    expect(res.body.since).toBe("2030-06-13T00:00:00.000Z");
    expect(res.body.activity.points.map((p) => p.t)).toEqual([
      "2030-06-13T00:00:00.000Z",
      "2030-06-14T00:00:00.000Z",
      "2030-06-15T00:00:00.000Z",
    ]);
    expect(sum(res.body, "reads")).toBe(1);
  });

  it("a read in the partly pruned first bucket is excluded", async () => {
    build(10);
    // 23:30Z, now - 10d = 2030-06-05T23:30: bucket 06-05 is partly pruned, and
    // the first whole bucket is 06-06 (no extra margin pushes it to 06-07).
    clock.ms = Date.parse("2030-06-15T23:30:00.000Z");
    audit("2030-06-05T20:00:00.000Z", "get_secret", { key: "K" });
    audit("2030-06-06T01:00:00.000Z", "get_secret", { key: "K" });
    const res = await get("?range=30d");
    expect(res.body.clamped).toBe(true);
    expect(res.body.since).toBe("2030-06-06T00:00:00.000Z");
    expect(res.body.activity.points[0].t).toBe("2030-06-06T00:00:00.000Z");
    expect(sum(res.body, "reads")).toBe(1);
    expect(res.body.top_keys).toEqual([{ key: "K", reads: 1 }]);
  });

  it("default retention (90d) with the 90d range is unclamped at any time of day", async () => {
    for (const time of ["00:00:00.000", "10:30:00.000", "23:30:00.000"]) {
      clock.ms = Date.parse(`2030-06-15T${time}Z`);
      const res = await get("?range=90d");
      expect(res.body.clamped, time).toBe(false);
      expect(res.body.since, time).toBe("2030-03-18T00:00:00.000Z");
      expect(res.body.activity.points, time).toHaveLength(90);
    }
  });
});

describe("classification (9)", () => {
  it("counts reads, writes, failures and rate limits per the definitions", async () => {
    const ts = "2030-06-14T12:00:00.000Z";
    audit(ts, "get_secret", { key: "K" });
    audit(ts, "get_secret", { key: "K", status: "missing" });
    audit(ts, "get_secret", { key: "K", status: "error" });
    audit(ts, "export_env");
    audit(ts, "export_env", { status: "error" });
    audit(ts, "list_keys");
    audit(ts, "secret_created", { key: "K" });
    audit(ts, "secret_updated", { key: "K" });
    audit(ts, "secret_edited", { key: "K" });
    audit(ts, "secret_deleted", { key: "K" });
    audit(ts, "secret_deleted", { key: "K", status: "missing" });
    audit(ts, "import_env");
    audit(ts, "auth", { status: "failed" });
    audit(ts, "authz", { status: "forbidden" });
    audit(ts, "rate_limit", { status: "blocked" });
    audit(ts, "rate_limit", { status: "blocked" });
    audit(ts, "token_created");
    const res = await get();
    expect(sum(res.body, "reads")).toBe(2);
    expect(sum(res.body, "secret_writes")).toBe(5);
    expect(sum(res.body, "auth_failures")).toBe(2);
    expect(sum(res.body, "rate_limited")).toBe(2);
    const day = res.body.activity.points.find((p) =>
      p.t.startsWith("2030-06-14"),
    );
    expect(day).toMatchObject({
      reads: 2,
      secret_writes: 5,
      auth_failures: 2,
      rate_limited: 2,
    });
  });
});

describe("not read in window (10)", () => {
  it("lists an old secret nobody read, with its raw created_at", async () => {
    secret("A", "OLD", "2030-01-01T00:00:00.000Z");
    secret("A", "LEGACY", "2030-01-02 03:04:05");
    const res = await get();
    expect(res.body.unread.total).toBe(2);
    expect(res.body.unread.items).toEqual([
      { folder: "A", key: "OLD", created_at: "2030-01-01T00:00:00.000Z" },
      { folder: "A", key: "LEGACY", created_at: "2030-01-02 03:04:05" },
    ]);
  });

  it("a new-format read excludes the secret", async () => {
    secret("A", "K1");
    secret("A", "K2");
    audit(EVIDENCE_TS, "get_secret", { key: "K1", details: "folder=A" });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["A/K2"]);
  });

  it("a legacy NULL-details read of a key in two folders excludes both", async () => {
    secret("A", "K");
    secret("B", "K");
    audit(EVIDENCE_TS, "get_secret", { key: "K" });
    const res = await get();
    expect(res.body.unread.total).toBe(0);
  });

  it("a new-format read in folder A only leaves folder B listed", async () => {
    secret("A", "K");
    secret("B", "K");
    audit(EVIDENCE_TS, "get_secret", { key: "K", details: "folder=A" });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["B/K"]);
  });

  it("ignores reads that were not ok", async () => {
    secret("A", "K");
    audit(EVIDENCE_TS, "get_secret", {
      key: "K",
      status: "missing",
      details: "folder=A",
    });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["A/K"]);
  });

  it("a secret created inside the window is not listed", async () => {
    secret("A", "NEW1", "2030-06-10T00:00:00.000Z");
    secret("A", "NEW2", "2030-06-10 00:00:00");
    secret("A", "EDGE", "2030-06-09T00:00:00.000Z"); // == since: not before it
    const res = await get();
    expect(res.body.unread.total).toBe(0);
  });

  it("a secret_edited row counts the target (folder with a space) as read", async () => {
    secret("Prod East", "NEWNAME");
    secret("Prod East", "OTHER");
    audit(EVIDENCE_TS, "secret_edited", {
      key: "NEWNAME",
      details:
        "from=Prod East|OLDNAME to=Prod East|NEWNAME value_changed=false",
    });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["Prod East/OTHER"]);
  });

  it("a value-only PATCH counts as read, a bulk overwrite does not", async () => {
    secret("A", "PATCHED");
    secret("A", "BULKED");
    audit(EVIDENCE_TS, "secret_edited", {
      key: "PATCHED",
      details: "from=A|PATCHED to=A|PATCHED value_changed=true",
    });
    audit(EVIDENCE_TS, "secret_updated", {
      key: "BULKED",
      details: "folder=A",
    });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["A/BULKED"]);
  });

  it("a folder rename marks the target folder read, including an existing non-empty target", async () => {
    secret("Dst", "MOVED1");
    secret("Dst", "MOVED2");
    secret("Dst", "EXISTING");
    secret("Other", "K");
    audit(EVIDENCE_TS, "folder_renamed", {
      details: "Src -> Dst (2 secrets)",
    });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["Other/K"]);
  });

  it("an export_env that lists the folder covers it", async () => {
    secret("A", "K");
    secret("B", "K");
    secret("C", "K");
    audit(EVIDENCE_TS, "export_env", { details: "folders=A,B" });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["C/K"]);
  });

  it("a legacy export_env with NULL details covers every folder", async () => {
    secret("A", "K");
    secret("B", "K");
    audit(EVIDENCE_TS, "export_env");
    const res = await get();
    expect(res.body.unread.total).toBe(0);
  });

  it("an export with zero folders (folders=) covers nothing", async () => {
    secret("A", "K");
    audit(EVIDENCE_TS, "export_env", { details: "folders=" });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["A/K"]);
  });

  it("evidence outside the window does not count", async () => {
    secret("A", "K");
    audit("2030-06-08T23:59:59.999Z", "get_secret", {
      key: "K",
      details: "folder=A",
    });
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["A/K"]);
  });
});

describe("audit detail strings (11)", () => {
  const seedViaApi = (folder, key) =>
    request(app)
      .post("/api/secrets")
      .set(bearer(admin))
      .send({ key, value: "v", folder });
  const lastRow = (action) => auditRows(action).at(-1);

  it("get_secret ok and missing carry folder=<F>", async () => {
    await seedViaApi("Prod East", "K");
    await request(app)
      .get(`/api/secrets/${encodeURIComponent("Prod East")}/K`)
      .set(bearer(reader));
    expect(lastRow("get_secret")).toMatchObject({
      status: "ok",
      details: "folder=Prod East",
    });
    await request(app).get("/api/secrets/Nope/K").set(bearer(reader));
    expect(lastRow("get_secret")).toMatchObject({
      status: "missing",
      details: "folder=Nope",
    });
  });

  it("get_secret decrypt failure carries folder=<F> Decrypt failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedViaApi("A", "K");
    db.db.prepare("UPDATE secrets SET ciphertext = ?").run(Buffer.alloc(32));
    const res = await request(app).get("/api/secrets/A/K").set(bearer(reader));
    expect(res.status).toBe(500);
    expect(lastRow("get_secret")).toMatchObject({
      status: "error",
      details: "folder=A Decrypt failure",
    });
  });

  it("export_env lists the exported folders in binary order", async () => {
    await seedViaApi("b", "K");
    await seedViaApi("C", "K");
    await seedViaApi("a", "K");
    await request(app).get("/api/exports").set(bearer(admin));
    expect(lastRow("export_env")).toMatchObject({
      status: "ok",
      details: "folders=C,a,b",
    });
  });

  it("export_env of an empty vault writes folders= and a scoped export lists only its folders", async () => {
    await request(app).get("/api/exports").set(bearer(admin));
    expect(lastRow("export_env").details).toBe("folders=");
    await seedViaApi("A", "K");
    await seedViaApi("B", "K");
    await request(app).get("/api/exports").set(bearer(scoped));
    expect(lastRow("export_env").details).toBe("folders=A");
  });
});

describe("GET /api/secrets/:folder/:key folder validation", () => {
  const BAD_FOLDERS = {
    "control char": "a%01b",
    "NUL byte": "a%00b",
    newline: "a%0Ab",
    "bidi override": "a%E2%80%AEb",
    "over-long (129 chars)": "a".repeat(129),
    "equals sign": "a%3Db",
  };
  const auditCount = () =>
    db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n;

  for (const [label, folder] of Object.entries(BAD_FOLDERS)) {
    it(`rejects ${label} with 400 before any audit write`, async () => {
      const before = auditCount();
      for (const token of [reader, admin, scoped]) {
        const res = await request(app)
          .get(`/api/secrets/${folder}/K`)
          .set(bearer(token));
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ detail: "Invalid folder name" });
      }
      expect(auditCount()).toBe(before);
      expect(auditRows("get_secret")).toHaveLength(0);
      expect(auditRows("authz")).toHaveLength(0);
    });
  }

  it("a valid but unknown folder is still a 404 with a folder= audit row", async () => {
    const res = await request(app).get("/api/secrets/Nope/K").set(bearer(admin));
    expect(res.status).toBe(404);
    expect(auditRows("get_secret").at(-1).details).toBe("folder=Nope");
  });
});

describe("ordering and caps (12)", () => {
  it("secrets.folders orders by count desc then binary folder order", async () => {
    secret("b", "K");
    secret("C", "K");
    secret("A", "K1");
    secret("A", "K2");
    const res = await get();
    expect(res.body.secrets.folders.map((f) => f.folder)).toEqual([
      "A",
      "C",
      "b",
    ]);
  });

  it("caps unread at 50 with the true total, in deterministic order", async () => {
    for (let i = 0; i < 60; i += 1) {
      secret(`F${i % 3}`, `K_${String(i).padStart(2, "0")}`);
    }
    const res = await get();
    expect(res.body.unread.total).toBe(60);
    expect(res.body.unread.items).toHaveLength(50);
    const ids = unreadKeys(res.body);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]).toBe("F0/K_00");
  });

  it("caps top_keys and top_tokens at 10 with ties broken by name", async () => {
    const ts = "2030-06-14T12:00:00.000Z";
    for (let i = 0; i < 12; i += 1) {
      const n = String(i).padStart(2, "0");
      audit(ts, "get_secret", { key: `K${n}`, token: `t${n}` });
    }
    for (let i = 0; i < 3; i += 1) {
      audit(ts, "get_secret", { key: "Z", token: "zz" });
    }
    const res = await get();
    expect(res.body.top_keys).toHaveLength(10);
    expect(res.body.top_keys[0]).toEqual({ key: "Z", reads: 3 });
    expect(res.body.top_keys.slice(1).map((k) => k.key)).toEqual([
      "K00",
      "K01",
      "K02",
      "K03",
      "K04",
      "K05",
      "K06",
      "K07",
      "K08",
    ]);
    expect(res.body.top_tokens).toHaveLength(10);
    expect(res.body.top_tokens[0]).toEqual({ name: "zz", events: 3 });
    expect(res.body.top_tokens[1]).toEqual({ name: "t00", events: 1 });
  });

  it("top_keys merges folders by key name and top_tokens counts every action", async () => {
    const ts = "2030-06-14T12:00:00.000Z";
    audit(ts, "get_secret", { key: "K", token: "ci", details: "folder=A" });
    audit(ts, "get_secret", { key: "K", token: "ci", details: "folder=B" });
    audit(ts, "auth", { token: "ci", status: "failed" });
    const res = await get();
    expect(res.body.top_keys).toEqual([{ key: "K", reads: 2 }]);
    expect(res.body.top_tokens).toEqual([{ name: "ci", events: 3 }]);
  });
});

describe("tokens and schema", () => {
  it("counts active, expiring, expired and revoked tokens (13)", async () => {
    addToken(db, {
      name: "soon",
      role: "read",
      expiresAt: "2030-06-18T10:30:00.000Z",
    });
    addToken(db, {
      name: "gone",
      role: "read",
      expiresAt: "2030-06-14T10:30:00.000Z",
    });
    addToken(db, { name: "dead", role: "read" });
    db.revokeToken("dead");
    // admin, scopedw, reader (no expiry) and soon are active.
    const res = await get();
    expect(res.body.tokens).toEqual({
      active: 4,
      expiring_7d: 1,
      expired: 1,
      revoked_all_time: 1,
    });
  });

  it("the timestamp/action index exists and init is idempotent (14)", () => {
    const indexes = () =>
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_logs_ts_action'",
        )
        .all();
    expect(indexes()).toHaveLength(1);
    expect(() => db.initSchema()).not.toThrow();
    expect(indexes()).toHaveLength(1);
    const again = new Database(dbPath);
    expect(() => again.initSchema()).not.toThrow();
    again.db.close();
  });
});

describe("admin response cache", () => {
  const AGGREGATES = [
    "analyticsActivityCounts",
    "analyticsTopKeys",
    "analyticsTopTokens",
    "analyticsReadEvidence",
    "analyticsSecretsCreatedBefore",
  ];
  const calls = (spies) => spies.map((spy) => spy.mock.calls.length);

  it("a second admin call inside the TTL skips the aggregates, one after it re-runs them", async () => {
    build(90, { analyticsCacheMs: 5000 });
    const spies = AGGREGATES.map((name) => vi.spyOn(db, name));
    secret("A", "K1");

    const first = await get("?range=7d");
    expect(first.body.unread.total).toBe(1);
    expect(calls(spies)).toEqual([1, 1, 1, 1, 1]);

    secret("A", "K2"); // not visible while the cached body is served
    clock.ms += 4999;
    const second = await get("?range=7d");
    expect(calls(spies)).toEqual([1, 1, 1, 1, 1]);
    expect(second.body).toEqual(first.body);
    expect(second.body.generated_at).toBe(NOW);

    // another range has its own entry
    await get("?range=30d");
    expect(calls(spies)).toEqual([2, 2, 2, 2, 2]);

    clock.ms += 1; // 5000 ms after the build: expired
    const third = await get("?range=7d");
    expect(calls(spies)).toEqual([3, 3, 3, 3, 3]);
    expect(third.body.unread.total).toBe(2);
    expect(third.body.generated_at).not.toBe(NOW);
  });

  it("non-admin responses are never cached and never served from the admin cache", async () => {
    build(90, { analyticsCacheMs: 5000 });
    secret("A", "K1");
    secret("B", "K2");
    const adminRes = await get("?range=7d");
    expect(adminRes.body.secrets.total).toBe(2);

    const scopedFirst = await get("?range=7d", scoped);
    expect(scopedFirst.body.admin).toBe(false);
    expect(scopedFirst.body.secrets).toEqual({
      total: 1,
      folders: [{ folder: "A", count: 1 }],
    });
    expect(scopedFirst.body.unread).toBeNull();

    secret("A", "K3");
    const scopedSecond = await get("?range=7d", scoped);
    expect(scopedSecond.body.secrets.total).toBe(2); // rebuilt, not cached
    const readerRes = await get("?range=7d", reader);
    expect(readerRes.body.admin).toBe(false);
    expect(readerRes.body.tokens).toBeNull();
    expect(readerRes.body.secrets.total).toBe(3);
  });

  it("cacheMs 0 disables the cache", async () => {
    const spy = vi.spyOn(db, "analyticsTopKeys");
    await get();
    await get();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("prepares each analytics statement once", async () => {
    const prepare = vi.spyOn(db.db, "prepare");
    await get("?range=7d");
    const afterFirst = prepare.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await get("?range=7d");
    await get("?range=7d");
    expect(prepare.mock.calls.length).toBe(afterFirst);
  });
});

describe("end to end through the real routes", () => {
  const api = (method, url, token = admin) =>
    request(app)[method](url).set(bearer(token));
  const mk = async (folder, key, token = admin) => {
    const res = await api("post", "/api/secrets", token).send({
      key,
      value: "v",
      folder,
    });
    expect(res.status, `${folder}/${key}`).toBe(200);
  };

  // Audit rows get real timestamps: run the analytics clock at real time and
  // backdate the secrets so they predate the window.
  const analyticsNow = () => {
    clock.ms = Date.now() + 1000;
    db.db
      .prepare("UPDATE secrets SET created_at = '2020-01-01T00:00:00.000Z'")
      .run();
  };

  it("renamed, moved, folder-renamed and exported secrets are not unread; an untouched one is", async () => {
    await mk("Prod East", "OLDNAME");
    await mk("Src1", "MOVEME");
    await mk("Old Folder", "FK1");
    await mk("Old Folder", "FK2");
    await mk("A", "EXPORTED", scoped);
    await mk("Ctl", "UNTOUCHED");

    expect(
      (
        await api("patch", "/api/secrets/Prod%20East/OLDNAME").send({
          key: "NEWNAME",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("patch", "/api/secrets/Src1/MOVEME").send({
          folder: "Dst1",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("post", "/api/folders/rename").send({
          from: "Old Folder",
          to: "New Folder",
        })
      ).status,
    ).toBe(200);
    // scoped export: lists only folder A
    expect((await api("get", "/api/exports", scoped)).status).toBe(200);

    analyticsNow();
    const res = await get("?range=7d");
    expect(res.status).toBe(200);
    expect(res.body.secrets.total).toBe(6);
    expect(unreadKeys(res.body)).toEqual(["Ctl/UNTOUCHED"]);
    expect(res.body.unread.total).toBe(1);
    // writes: 6 creates + 2 edits are counted, folder rename is not a secret write
    expect(sum(res.body, "secret_writes")).toBe(8);
    expect(sum(res.body, "reads")).toBe(1); // the export
  });

  it("an unscoped export covers every folder", async () => {
    await mk("A", "K1");
    await mk("B", "K2");
    await api("get", "/api/exports");
    analyticsNow();
    const res = await get();
    expect(res.body.unread.total).toBe(0);
  });

  it("a real get_secret read excludes only that folder's secret", async () => {
    await mk("A", "K");
    await mk("B", "K");
    expect((await api("get", "/api/secrets/A/K", reader)).status).toBe(200);
    analyticsNow();
    const res = await get();
    expect(unreadKeys(res.body)).toEqual(["B/K"]);
    expect(res.body.top_keys).toEqual([{ key: "K", reads: 1 }]);
  });

  it("a real import_env counts as one secret write", async () => {
    const res = await request(app)
      .post("/api/import")
      .set(bearer(admin))
      .set("Content-Type", "text/plain")
      .send("# folder=Imp\nONE=1\nTWO=2\nTHREE=3\n");
    expect(res.status).toBeLessThan(300);
    expect(auditRows("import_env")).toHaveLength(1);
    analyticsNow();
    const body = (await get()).body;
    expect(sum(body, "secret_writes")).toBe(1);
    expect(sum(body, "reads")).toBe(0);
    expect(unreadKeys(body)).toEqual(["Imp/ONE", "Imp/THREE", "Imp/TWO"]);
  });

  it("a real public-limiter 429 is classified as rate_limited", async () => {
    build(90, { publicRateLimitPerMinute: 1 });
    await mk("A", "K");
    expect((await api("get", "/api/secrets/A/K", reader)).status).toBe(200);
    const limited = await api("get", "/api/secrets/A/K", reader);
    expect(limited.status).toBe(429);
    expect(auditRows("rate_limit")).toHaveLength(1);
    analyticsNow();
    const body = (await get()).body;
    expect(sum(body, "rate_limited")).toBe(1);
    expect(sum(body, "reads")).toBe(1);
    expect(sum(body, "auth_failures")).toBe(0);
  });
});
