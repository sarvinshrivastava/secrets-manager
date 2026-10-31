import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { makeApp, addToken, bearer } from "./helpers.js";

let ctx;
let write;
let read;
let scoped;

beforeEach(() => {
  ctx = makeApp();
  write = addToken(ctx.db, { name: "admin", role: "write" });
  read = addToken(ctx.db, { name: "reader", role: "read" });
  scoped = addToken(ctx.db, { name: "scopedw", role: "write", scope: "A" });
});
afterEach(() => {
  ctx.cleanup();
});

const seed = (folder, key, value = "v") =>
  request(ctx.app)
    .post("/api/secrets")
    .set(bearer(write))
    .send({ key, value, folder });
const patch = (path, body, token = write) =>
  request(ctx.app).patch(`/api/secrets/${path}`).set(bearer(token)).send(body);
const getValue = async (folder, key) => {
  const res = await request(ctx.app)
    .get(`/api/secrets/${encodeURIComponent(folder)}/${key}`)
    .set(bearer(read));
  return res;
};
const auditRows = (action = "secret_edited") =>
  ctx.db.db
    .prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY id ASC")
    .all(action);
const rowOf = (folder, key) => ctx.db.getSecret(folder, key);

describe("PATCH /api/secrets/:folder/:key", () => {
  it("renames, moves, replaces the value, and all three; id and created_at survive", async () => {
    await seed("F", "K", "v1");
    const original = rowOf("F", "K");

    let res = await patch("F/K", { key: "K2" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", key: "K2", folder: "F" });
    expect((await getValue("F", "K2")).body.value).toBe("v1");
    expect((await getValue("F", "K")).status).toBe(404);

    res = await patch("F/K2", { folder: "  My Folder  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", key: "K2", folder: "My Folder" });
    expect((await getValue("My Folder", "K2")).body.value).toBe("v1");

    res = await patch("My%20Folder/K2", { value: "v2" });
    expect(res.status).toBe(200);
    expect((await getValue("My Folder", "K2")).body.value).toBe("v2");

    res = await patch("My%20Folder/K2", {
      key: "K3",
      folder: "G",
      value: "v3",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", key: "K3", folder: "G" });
    expect((await getValue("G", "K3")).body.value).toBe("v3");

    const after = rowOf("G", "K3");
    expect(after.id).toBe(original.id);
    expect(after.created_at).toBe(original.created_at);
  });

  it("writes an exact audit row per edit, without any value", async () => {
    await seed("F", "K", "topsecret");
    await patch("F/K", { key: "K2" });
    await patch("F/K2", { key: "K3", folder: "G", value: "newsecret" });

    const rows = auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      token_name: "admin",
      action: "secret_edited",
      key_name: "K2",
      status: "ok",
      details: "from=F|K to=F|K2 value_changed=false",
    });
    expect(rows[1]).toMatchObject({
      token_name: "admin",
      key_name: "K3",
      status: "ok",
      details: "from=F|K2 to=G|K3 value_changed=true",
    });
    expect(JSON.stringify(rows)).not.toMatch(/topsecret|newsecret/);
  });

  it.each([
    ["empty object", "F/K", {}],
    ["unknown field only", "F/K", { nope: "x" }],
    ["array body", "F/K", []],
    ["key null", "F/K", { key: null }],
    ["folder null", "F/K", { folder: null }],
    ["value null", "F/K", { value: null }],
    ["key number", "F/K", { key: 5 }],
    ["value array", "F/K", { value: ["a"] }],
    ["folder object", "F/K", { folder: {} }],
    ["folder blank (no Root fallback)", "F/K", { folder: "" }],
    ["folder whitespace", "F/K", { folder: "   " }],
    ["folder dot-dot", "F/K", { folder: ".." }],
    ["folder dot", "F/K", { folder: "." }],
    ["folder illegal chars", "F/K", { folder: "a/b" }],
    ["invalid path key", "F/1BAD", { value: "x" }],
    ["invalid new key", "F/K", { key: "1BAD" }],
    ["empty new key", "F/K", { key: "" }],
    ["129-char new key", "F/K", { key: "A".repeat(129) }],
    ["32769-byte value", "F/K", { value: "a".repeat(32769) }],
  ])("400 on %s, and nothing changes", async (_name, path, body) => {
    await seed("F", "K", "orig");
    const res = await patch(path, body);
    expect(res.status).toBe(400);
    expect((await getValue("F", "K")).body.value).toBe("orig");
    expect(auditRows()).toHaveLength(0);
  });

  it("400 on a literal null body and on malformed JSON", async () => {
    await seed("F", "K");
    for (const raw of ["null", '{"key":']) {
      const res = await request(ctx.app)
        .patch("/api/secrets/F/K")
        .set(bearer(write))
        .set("Content-Type", "application/json")
        .send(raw);
      expect(res.status).toBe(400);
    }
  });

  it("allows an empty-string value and a 32768-byte value", async () => {
    await seed("F", "K", "orig");
    expect((await patch("F/K", { value: "" })).status).toBe(200);
    expect((await getValue("F", "K")).body.value).toBe("");
    expect((await patch("F/K", { value: "a".repeat(32768) })).status).toBe(200);
  });

  it("403 for a read token, 401 without a token", async () => {
    await seed("F", "K");
    expect((await patch("F/K", { value: "x" }, read)).status).toBe(403);
    const anon = await request(ctx.app)
      .patch("/api/secrets/F/K")
      .send({ value: "x" });
    expect(anon.status).toBe(401);
  });

  it("403 when the source or the target folder is outside the token scope", async () => {
    await seed("A", "K");
    await seed("B", "K");

    let res = await patch("B/K", { value: "x" }, scoped);
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain("'B'");

    res = await patch("A/K", { folder: "B", key: "K2" }, scoped);
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain("'B'");
    expect(rowOf("A", "K")).toBeTruthy();

    expect((await patch("A/K", { key: "K2" }, scoped)).status).toBe(200);
    expect((await getValue("B", "K")).body.value).toBe("v");
  });

  it("404 for a missing source, audited as secret_edited/missing", async () => {
    const res = await patch("F/NOPE", { value: "x" });
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Secret not found");
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "missing", key_name: "NOPE" });
  });

  it("409 when the target exists (rename and move); nothing changes", async () => {
    await seed("F", "K", "mine");
    await seed("F", "T", "theirs");
    await seed("G", "K", "other");

    let res = await patch("F/K", { key: "T" });
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("Secret 'T' already exists in folder 'F'");

    res = await patch("F/K", { folder: "G" });
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("Secret 'K' already exists in folder 'G'");

    expect((await getValue("F", "K")).body.value).toBe("mine");
    expect((await getValue("F", "T")).body.value).toBe("theirs");
    expect((await getValue("G", "K")).body.value).toBe("other");
    expect(auditRows()).toHaveLength(0);
  });

  it("409 (not 500) when the UNIQUE constraint trips past the pre-check", async () => {
    await seed("F", "K", "mine");
    // Simulate a concurrent writer: the pre-check sees nothing, the UPDATE
    // then hits the constraint.
    const realGet = ctx.db.getSecret.bind(ctx.db);
    ctx.db.getSecret = (folder, key) =>
      folder === "F" && key === "T" ? null : realGet(folder, key);
    await seed("F", "T", "theirs");

    const res = await patch("F/K", { key: "T" });
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("Secret 'T' already exists in folder 'F'");
    expect(auditRows()).toHaveLength(0);
  });

  it("no-op (same key/folder, no value) is 200 with no write and no audit", async () => {
    await seed("F", "K", "v");
    const before = rowOf("F", "K");

    for (const body of [
      { key: "K" },
      { folder: "F" },
      { key: "K", folder: " F " },
    ]) {
      const res = await patch("F/K", body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", key: "K", folder: "F" });
    }
    const after = rowOf("F", "K");
    expect(Buffer.compare(after.nonce, before.nonce)).toBe(0);
    expect(Buffer.compare(after.ciphertext, before.ciphertext)).toBe(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("a present value is never a no-op: it re-encrypts and audits value_changed=true", async () => {
    await seed("F", "K", "v");
    const before = rowOf("F", "K");
    const res = await patch("F/K", { key: "K", value: "v" });
    expect(res.status).toBe(200);
    const after = rowOf("F", "K");
    expect(Buffer.compare(after.nonce, before.nonce)).not.toBe(0);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toBe("from=F|K to=F|K value_changed=true");
  });

  it("POST still rejects an existing key (create stays non-overwriting)", async () => {
    await seed("F", "K");
    expect((await seed("F", "K", "again")).status).toBe(409);
  });
});

describe("dot-only folder names on create/bulk", () => {
  it("POST rejects '.', '..' and '...'", async () => {
    for (const folder of [".", "..", "..."]) {
      const res = await seed(folder, "K");
      expect(res.status).toBe(400);
    }
  });
  it("bulk rejects a dot-only folder", async () => {
    const res = await request(ctx.app)
      .post("/api/secrets/bulk")
      .set(bearer(write))
      .send({ folder: "..", secrets: [{ key: "K", value: "v" }] });
    expect(res.status).toBe(400);
  });
});

// Body-parser error messages quote the request body (V8 prints the offending
// JSON snippet), so a malformed body carrying a secret must never be echoed or
// logged. The parse error fires before auth, so no token is needed.
describe("malformed JSON bodies never leak the value", () => {
  it("returns a fixed detail and logs no body snippet", async () => {
    const logs = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a) => logs.push(a.join(" ")));
    try {
      const res = await request(ctx.app)
        .patch("/api/secrets/A/K")
        .set("Content-Type", "application/json")
        .send('{"value": hunter2}');
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe("Invalid JSON body");
      expect(JSON.stringify(res.body)).not.toContain("hunter2");
      expect(logs.join("\n")).not.toContain("hunter2");
    } finally {
      spy.mockRestore();
    }
  });

  it("API responses are no-store", async () => {
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(write));
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
