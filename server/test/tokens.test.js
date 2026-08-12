import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeApp, addToken, bearer } from "./helpers.js";

let ctx;
let write;

beforeEach(() => {
  ctx = makeApp();
  write = addToken(ctx.db, { name: "admin", role: "write" });
});
afterEach(() => {
  ctx.cleanup();
});

describe("POST /api/tokens", () => {
  it("returns a <name>.<secret> wire token", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    expect(res.status).toBe(201);
    expect(res.body.token.startsWith("svc.")).toBe(true);
    expect(res.body.scope).toBe("*");
  });

  it("accepts and stores a folder scope", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "scoped", role: "read", scope: ["TeamA", "TeamB"] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("TeamA,TeamB");
  });

  it("rejects an invalid folder name in scope (400)", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "scoped", role: "read", scope: ["bad/slash"] });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer expires_in_seconds", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read", expires_in_seconds: 1.5 });
    expect(res.status).toBe(400);
  });

  it("clamps a huge expires_in_seconds instead of 500ing", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read", expires_in_seconds: 1e20 });
    expect(res.status).toBe(201);
    // Must be a valid ISO date (no Invalid Date crash), within ~10 years.
    const exp = new Date(res.body.expires_at);
    expect(Number.isNaN(exp.getTime())).toBe(false);
    const tenYearsMs = 10 * 366 * 24 * 60 * 60 * 1000;
    expect(exp.getTime() - Date.now()).toBeLessThanOrEqual(tenYearsMs);
  });

  it("allows recreating a token whose name was revoked (no 500)", async () => {
    // Need a second write token so the first can be revoked (last-write guard).
    await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "write" });
    const revoke = await request(ctx.app)
      .delete("/api/tokens/svc")
      .set(bearer(write));
    expect(revoke.status).toBe(200);

    const recreate = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    expect(recreate.status).toBe(201);
    expect(recreate.body.token.startsWith("svc.")).toBe(true);

    // The recreated token actually authenticates.
    const me = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer(recreate.body.token));
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("read");
  });

  it("409 when recreating an ACTIVE token name", async () => {
    await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    const dup = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    expect(dup.status).toBe(409);
  });

  it("cannot revoke the last active write token", async () => {
    const res = await request(ctx.app)
      .delete("/api/tokens/admin")
      .set(bearer(write));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/tokens — scoping subset model", () => {
  it("admin may grant any scope", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read", scope: ["A", "B"] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("A,B");
  });

  it("a scoped caller may grant a multi-folder subset (201)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B,C",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["A", "B"] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("A,B");
  });

  it("a scoped caller cannot grant a partly out-of-scope set (403)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["A", "C"] });
    expect(res.status).toBe(403);
  });

  it("a scoped caller may grant a subset (201)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["A"] });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("A");
  });

  it("a scoped caller cannot grant a superset (403)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["A", "B"] });
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe("Cannot grant scope beyond your own");
  });

  it("a scoped caller cannot grant a sibling folder (403)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["B"] });
    expect(res.status).toBe(403);
  });

  it("a scoped caller cannot grant `*` (403)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read", scope: ["*"] });
    expect(res.status).toBe(403);
  });

  it("an unscoped request defaults to the caller's OWN scope (not `*`)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(scoped))
      .send({ name: "svc", role: "read" });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("A,B");
  });

  it("an unscoped admin request still defaults to `*`", async () => {
    const res = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe("*");
  });
});

describe("rotate / revoke — target scope model", () => {
  it("a scoped token cannot rotate admin (scope `*` ⊄ scoped) → 403", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    const res = await request(ctx.app)
      .post("/api/tokens/admin/rotate")
      .set(bearer(scoped));
    expect(res.status).toBe(403);
  });

  it("a scoped token cannot revoke admin → 403", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    const res = await request(ctx.app)
      .delete("/api/tokens/admin")
      .set(bearer(scoped));
    expect(res.status).toBe(403);
  });

  it("admin can rotate a scoped token (200)", async () => {
    addToken(ctx.db, { name: "svc", role: "read", scope: "A" });
    const res = await request(ctx.app)
      .post("/api/tokens/svc/rotate")
      .set(bearer(write));
    expect(res.status).toBe(200);
    expect(res.body.token.startsWith("svc.")).toBe(true);
  });

  it("a scoped token can rotate a token within its scope (200)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    addToken(ctx.db, { name: "svc", role: "read", scope: "A" });
    const res = await request(ctx.app)
      .post("/api/tokens/svc/rotate")
      .set(bearer(scoped));
    expect(res.status).toBe(200);
  });

  it("a scoped caller can revoke an in-scope token (200)", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    // A 2nd in-scope write token so the last-write guard does not trip on revoke.
    addToken(ctx.db, { name: "svc", role: "write", scope: "A" });
    const res = await request(ctx.app)
      .delete("/api/tokens/svc")
      .set(bearer(scoped));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
  });

  it("admin can revoke a scoped token (200)", async () => {
    addToken(ctx.db, { name: "svc", role: "write", scope: "A" });
    const res = await request(ctx.app)
      .delete("/api/tokens/svc")
      .set(bearer(write));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
  });
});

describe("GET /api/tokens — scope-filtered list", () => {
  it("admin sees all tokens", async () => {
    addToken(ctx.db, { name: "a-svc", role: "read", scope: "A" });
    addToken(ctx.db, { name: "b-svc", role: "read", scope: "B" });
    const res = await request(ctx.app).get("/api/tokens").set(bearer(write));
    const names = res.body.tokens.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["admin", "a-svc", "b-svc"]));
  });

  it("a scoped caller only sees tokens within its scope", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A",
    });
    addToken(ctx.db, { name: "a-svc", role: "read", scope: "A" });
    addToken(ctx.db, { name: "b-svc", role: "read", scope: "B" });
    const res = await request(ctx.app).get("/api/tokens").set(bearer(scoped));
    const names = res.body.tokens.map((t) => t.name).sort();
    // Sees itself + the A-scoped token; NOT admin (`*`) nor the B-scoped token.
    expect(names).toEqual(["a-svc", "team"]);
  });

  it("an A,B caller sees A/B/A,B subsets and self, never C or `*`", async () => {
    const scoped = addToken(ctx.db, {
      name: "team",
      role: "write",
      scope: "A,B",
    });
    addToken(ctx.db, { name: "tok-a", role: "read", scope: "A" });
    addToken(ctx.db, { name: "tok-b", role: "read", scope: "B" });
    addToken(ctx.db, { name: "tok-c", role: "read", scope: "C" });
    addToken(ctx.db, { name: "tok-ab", role: "read", scope: "A,B" });
    addToken(ctx.db, { name: "tok-star", role: "read", scope: "*" });
    const res = await request(ctx.app).get("/api/tokens").set(bearer(scoped));
    const names = res.body.tokens.map((t) => t.name).sort();
    // admin (`*`) from beforeEach and tok-star/tok-c are all excluded.
    expect(names).toEqual(["team", "tok-a", "tok-ab", "tok-b"]);
  });
});

describe("POST /api/tokens/:name/rotate — always server-random", () => {
  it("ignores a caller-supplied token; old token dies, new works", async () => {
    const created = await request(ctx.app)
      .post("/api/tokens")
      .set(bearer(write))
      .send({ name: "svc", role: "read" });
    const oldToken = created.body.token;

    const customHex = "a".repeat(64);
    const rot = await request(ctx.app)
      .post("/api/tokens/svc/rotate")
      .set(bearer(write))
      .send({ token: customHex });
    expect(rot.status).toBe(200);
    const newToken = rot.body.token;

    // The custom hex must NOT have been used as the secret.
    expect(newToken).not.toBe(`svc.${customHex}`);
    expect(newToken.startsWith("svc.")).toBe(true);
    expect(newToken).not.toBe(oldToken);

    // Old token is now invalid; new token authenticates.
    const oldRes = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer(oldToken));
    expect(oldRes.status).toBe(401);

    const newRes = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer(newToken));
    expect(newRes.status).toBe(200);
  });
});

describe("countWriteTokens excludes expired write tokens", () => {
  it("an expired write token does not keep the vault healthy", () => {
    const c = makeApp();
    // Only write token is expired.
    addToken(c.db, {
      name: "old",
      role: "write",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(c.db.countWriteTokens()).toBe(0);
    addToken(c.db, { name: "fresh", role: "write" });
    expect(c.db.countWriteTokens()).toBe(1);
    c.cleanup();
  });
});
