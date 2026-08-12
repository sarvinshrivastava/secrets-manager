import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeApp, addToken, bearer } from "./helpers.js";

let ctx;
let write;
let read;

beforeEach(() => {
  ctx = makeApp();
  write = addToken(ctx.db, { name: "admin", role: "write" });
  read = addToken(ctx.db, { name: "reader", role: "read" });
});
afterEach(() => {
  ctx.cleanup();
});

describe("secrets CRUD", () => {
  it("creates, reads, and deletes a secret", async () => {
    const created = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "API_KEY", value: "s3cr3t", folder: "Root" });
    expect(created.status).toBe(200);

    const got = await request(ctx.app)
      .get("/api/secrets/Root/API_KEY")
      .set(bearer(read));
    expect(got.status).toBe(200);
    expect(got.body.value).toBe("s3cr3t");

    const del = await request(ctx.app)
      .delete("/api/secrets/Root/API_KEY")
      .set(bearer(write));
    expect(del.status).toBe(200);

    const gone = await request(ctx.app)
      .get("/api/secrets/Root/API_KEY")
      .set(bearer(read));
    expect(gone.status).toBe(404);
  });

  it("409 on duplicate key in same folder", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "DUP", value: "1" });
    const dup = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "DUP", value: "2" });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid folder name on create", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "v", folder: "bad/slash" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid key", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "1BAD", value: "v" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/secrets/bulk", () => {
  it("adds new, skips existing, overwrites requested, reports invalid", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "EXISTING", value: "old", folder: "Root" });

    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({
        folder: "Root",
        secrets: [
          { key: "NEW_ONE", value: "n1" },
          { key: "EXISTING", value: "kept" }, // not in overwrite -> skipped
          { key: "OVERW", value: "first" },
          { key: "1INVALID", value: "x" }, // bad key
        ],
        overwrite: [],
      });

    expect(res.status).toBe(207);
    expect(res.body.added).toContain("NEW_ONE");
    expect(res.body.skipped).toContain("EXISTING");
    expect(res.body.invalid.map((i) => i.reason)).toContain("invalid key");

    // EXISTING stays "old" because it wasn't in overwrite.
    const existing = await request(ctx.app)
      .get("/api/secrets/Root/EXISTING")
      .set(bearer(read));
    expect(existing.body.value).toBe("old");
  });

  it("overwrites when key is listed in overwrite", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "OW", value: "old", folder: "Root" });

    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({
        folder: "Root",
        secrets: [{ key: "OW", value: "new" }],
        overwrite: ["OW"],
      });
    expect(res.body.updated).toContain("OW");

    const got = await request(ctx.app)
      .get("/api/secrets/Root/OW")
      .set(bearer(read));
    expect(got.body.value).toBe("new");
  });

  it("is scope-checked (403 for out-of-scope folder)", async () => {
    const scoped = addToken(ctx.db, {
      name: "svc",
      role: "write",
      scope: "Allowed",
    });
    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(scoped))
      .send({ folder: "Denied", secrets: [{ key: "K", value: "v" }] });
    expect(res.status).toBe(403);
  });
});

describe("folders API", () => {
  it("GET /api/folders lists distinct folders unioned with Root", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "v", folder: "Team" });
    const res = await request(ctx.app).get("/api/folders").set(bearer(read));
    expect(res.status).toBe(200);
    expect(res.body.folders).toEqual(expect.arrayContaining(["Root", "Team"]));
  });

  it("rename 409 when target has a colliding key", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "SHARED", value: "1", folder: "A" });
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "SHARED", value: "2", folder: "B" });
    const res = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(write))
      .send({ from: "A", to: "B" });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("SHARED");
  });

  it("rename succeeds without collision", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "1", folder: "Old" });
    const res = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(write))
      .send({ from: "Old", to: "New" });
    expect(res.status).toBe(200);
    expect(res.body.renamed).toBe(1);
  });

  it("reserves Root (409 renaming from or to Root)", async () => {
    const from = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(write))
      .send({ from: "Root", to: "X" });
    expect(from.status).toBe(409);
    const to = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(write))
      .send({ from: "X", to: "Root" });
    expect(to.status).toBe(409);
  });
});

describe("export / import folder round-trip", () => {
  it("preserves folders and values across export -> import", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "SAME", value: "a-val", folder: "A" });
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "SAME", value: "b-val", folder: "B" });
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "TRICKY", value: "C:\\new\npath", folder: "A" });

    const exported = await request(ctx.app)
      .get("/api/exports")
      .set(bearer(write));
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("# folder=A");
    expect(exported.text).toContain("# folder=B");

    // Wipe and re-import into a fresh app.
    const ctx2 = makeApp();
    const write2 = addToken(ctx2.db, { name: "admin", role: "write" });
    const read2 = addToken(ctx2.db, { name: "reader", role: "read" });
    const imported = await request(ctx2.app)
      .post("/api/import")
      .set(bearer(write2))
      .set("Content-Type", "text/plain")
      .send(exported.text);
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(3);

    const a = await request(ctx2.app)
      .get("/api/secrets/A/SAME")
      .set(bearer(read2));
    const b = await request(ctx2.app)
      .get("/api/secrets/B/SAME")
      .set(bearer(read2));
    const tricky = await request(ctx2.app)
      .get("/api/secrets/A/TRICKY")
      .set(bearer(read2));
    expect(a.body.value).toBe("a-val");
    expect(b.body.value).toBe("b-val");
    expect(tricky.body.value).toBe("C:\\new\npath");
    ctx2.cleanup();
  });

  it("import honors ?folder= query default", async () => {
    const res = await request(ctx.app)
      .post("/api/import?folder=Custom")
      .set(bearer(write))
      .set("Content-Type", "text/plain")
      .send("KEY_ONE=value1\n");
    expect(res.body.imported).toBe(1);
    const got = await request(ctx.app)
      .get("/api/secrets/Custom/KEY_ONE")
      .set(bearer(read));
    expect(got.body.value).toBe("value1");
  });

  it("import is atomic (bad line rolls back)", async () => {
    const res = await request(ctx.app)
      .post("/api/import")
      .set(bearer(write))
      .set("Content-Type", "text/plain")
      .send("GOOD_KEY=ok\nnot a valid line without equals-sign-key!");
    expect(res.status).toBe(400);
    const got = await request(ctx.app)
      .get("/api/secrets/Root/GOOD_KEY")
      .set(bearer(read));
    expect(got.status).toBe(404); // rolled back
  });
});

describe("audit log gating", () => {
  it("read token is forbidden (403)", async () => {
    const res = await request(ctx.app).get("/api/audit-logs").set(bearer(read));
    expect(res.status).toBe(403);
  });

  it("write token may read audit logs", async () => {
    const res = await request(ctx.app)
      .get("/api/audit-logs")
      .set(bearer(write));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});

describe("error handler + 404", () => {
  it("malformed JSON returns 400 (not 500)", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .set("Content-Type", "application/json")
      .send("{ not json ");
    expect(res.status).toBe(400);
  });

  it("unknown /api route returns terminal JSON 404", async () => {
    const res = await request(ctx.app)
      .get("/api/does-not-exist")
      .set(bearer(write));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "Not found" });
  });
});

describe("rate limiting", () => {
  it("sets Retry-After header on 429", async () => {
    const limited = makeApp({ rateLimitPerMinute: 1 });
    const tok = addToken(limited.db, { name: "reader", role: "read" });
    await request(limited.app).get("/api/auth/me").set(bearer(tok));
    const res = await request(limited.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    limited.cleanup();
  });

  it("public GET endpoint has its own per-IP limit → 429 + Retry-After + audit", async () => {
    const limited = makeApp({ publicRateLimitPerMinute: 1 });
    const w = addToken(limited.db, { name: "admin", role: "write" });
    const r = addToken(limited.db, { name: "reader", role: "read" });
    await request(limited.app)
      .post("/api/secrets")
      .set(bearer(w))
      .send({ key: "K", value: "v", folder: "Root" });

    const first = await request(limited.app)
      .get("/api/secrets/Root/K")
      .set(bearer(r));
    expect(first.status).toBe(200);

    const second = await request(limited.app)
      .get("/api/secrets/Root/K")
      .set(bearer(r));
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();

    const blocked = limited.db.listAuditLogs({ action: "rate_limit" });
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((e) => e.details.includes("Public endpoint"))).toBe(
      true,
    );
    limited.cleanup();
  });
});

describe("folder rename scoping", () => {
  it("403 when source is outside the caller's scope", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "v", folder: "Denied" });
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "Allowed",
    });
    const res = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(scoped))
      .send({ from: "Denied", to: "Allowed" });
    expect(res.status).toBe(403);
  });

  it("403 when target is outside the caller's scope", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "v", folder: "Allowed" });
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "Allowed",
    });
    const res = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(scoped))
      .send({ from: "Allowed", to: "Denied" });
    expect(res.status).toBe(403);
  });

  it("200 when both source and target are in scope", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "K", value: "v", folder: "Src" });
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "Src,Dst",
    });
    const res = await request(ctx.app)
      .post("/api/folders/rename")
      .set(bearer(scoped))
      .send({ from: "Src", to: "Dst" });
    expect(res.status).toBe(200);
  });
});

describe("bulk caps and rollback", () => {
  it("rejects a batch over MAX_BULK_ENTRIES (400)", async () => {
    const secrets = [];
    for (let i = 0; i < 501; i += 1) {
      secrets.push({ key: `K_${i}`, value: "v" });
    }
    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({ folder: "Root", secrets });
    expect(res.status).toBe(400);
  });

  it("flags an oversized value as invalid (byte count, not char length)", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({
        folder: "Root",
        secrets: [{ key: "BIG", value: "a".repeat(32769) }],
      });
    expect(res.status).toBe(207);
    expect(res.body.invalid).toEqual([{ key: "BIG", reason: "invalid value" }]);
  });

  it("flags a non-string value as invalid", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({ folder: "Root", secrets: [{ key: "NUM", value: 123 }] });
    expect(res.status).toBe(207);
    expect(res.body.invalid).toEqual([{ key: "NUM", reason: "invalid value" }]);
  });

  it("rolls the whole batch back when a write throws mid-transaction", async () => {
    let calls = 0;
    const orig = ctx.db.createSecret.bind(ctx.db);
    ctx.db.createSecret = (...args) => {
      calls += 1;
      if (calls === 3) throw new Error("injected failure");
      return orig(...args);
    };

    await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({
        folder: "Root",
        secrets: [
          { key: "K1", value: "1" },
          { key: "K2", value: "2" },
          { key: "K3", value: "3" },
        ],
      });

    ctx.db.createSecret = orig;

    // Keys 1-2 must be absent (rolled back).
    const k1 = await request(ctx.app)
      .get("/api/secrets/Root/K1")
      .set(bearer(read));
    const k2 = await request(ctx.app)
      .get("/api/secrets/Root/K2")
      .set(bearer(read));
    expect(k1.status).toBe(404);
    expect(k2.status).toBe(404);

    // And no secret_created audit rows survived the rollback.
    const created = ctx.db.listAuditLogs({ action: "secret_created" });
    expect(created.length).toBe(0);
  });

  it("writes exactly one audit row per added/updated key", async () => {
    await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "EXIST", value: "old", folder: "Root" });

    await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({
        folder: "Root",
        secrets: [
          { key: "NEW1", value: "n1" },
          { key: "NEW2", value: "n2" },
          { key: "EXIST", value: "new" },
        ],
        overwrite: ["EXIST"],
      });

    const created = ctx.db
      .listAuditLogs({ action: "secret_created", limit: 500 })
      .filter((e) => ["NEW1", "NEW2"].includes(e.key_name));
    const updated = ctx.db
      .listAuditLogs({ action: "secret_updated", limit: 500 })
      .filter((e) => e.key_name === "EXIST");
    expect(created.length).toBe(2);
    expect(updated.length).toBe(1);
  });
});

describe("single-create byte-count value cap", () => {
  it("rejects a value whose UTF-8 byte length exceeds the cap (400)", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "BIG", value: "a".repeat(32769) });
    expect(res.status).toBe(400);
  });

  it("counts multi-byte characters by bytes, not JS string length", async () => {
    // Each '€' is 3 UTF-8 bytes: 11000 chars = 33000 bytes > 32768.
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .send({ key: "EURO", value: "€".repeat(11000) });
    expect(res.status).toBe(400);
  });
});

describe("oversized request body", () => {
  it("returns 413 when the JSON body exceeds the 256kb cap", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(write))
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ key: "K", value: "a".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
  });
});

describe("import edge cases", () => {
  it("400 on an invalid `# folder=` header", async () => {
    const res = await request(ctx.app)
      .post("/api/import")
      .set(bearer(write))
      .set("Content-Type", "text/plain")
      .send("# folder=bad/slash\nK=v\n");
    expect(res.status).toBe(400);
  });

  it("strips a server-side `export KEY=v` prefix", async () => {
    const res = await request(ctx.app)
      .post("/api/import")
      .set(bearer(write))
      .set("Content-Type", "text/plain")
      .send("export MY_KEY=val\n");
    expect(res.body.imported).toBe(1);
    const got = await request(ctx.app)
      .get("/api/secrets/Root/MY_KEY")
      .set(bearer(read));
    expect(got.body.value).toBe("val");
  });

  it("400 on an invalid ?folder= query", async () => {
    const res = await request(ctx.app)
      .post("/api/import?folder=bad/slash")
      .set(bearer(write))
      .set("Content-Type", "text/plain")
      .send("K=v\n");
    expect(res.status).toBe(400);
  });

  it("403 when importing into an out-of-scope folder", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "Allowed",
    });
    const res = await request(ctx.app)
      .post("/api/import?folder=Denied")
      .set(bearer(scoped))
      .set("Content-Type", "text/plain")
      .send("K=v\n");
    expect(res.status).toBe(403);
  });
});

describe("security headers + healthz", () => {
  it("sets X-Frame-Options DENY and X-Content-Type-Options nosniff", async () => {
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(read));
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("/healthz returns 200 ok when the DB is reachable", async () => {
    const res = await request(ctx.app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("/healthz returns 503 when the DB probe throws", async () => {
    const broken = makeApp();
    broken.db.db.close(); // subsequent SELECT 1 throws
    const res = await request(broken.app).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error" });
    broken.cleanup();
  });
});
