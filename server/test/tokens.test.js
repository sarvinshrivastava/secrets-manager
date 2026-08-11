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
