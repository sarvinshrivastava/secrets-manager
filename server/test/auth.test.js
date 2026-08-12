import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  makeApp,
  addToken,
  addBareToken,
  bearer,
  cryptoManager,
  isoInPast,
  isoInFuture,
} from "./helpers.js";

let ctx;
beforeEach(() => {
  ctx = makeApp();
});
afterEach(() => {
  ctx.cleanup();
});

function seedSecret(db, folder, key, value) {
  const enc = cryptoManager.encryptValue(value);
  db.createSecret(folder, key, enc.nonce, enc.ciphertext);
}

describe("auth middleware", () => {
  it("401 on missing token", async () => {
    const res = await request(ctx.app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("401 on an unknown named token", async () => {
    addToken(ctx.db, { name: "reader", role: "read" });
    const res = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer("reader.wrongsecret"));
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Invalid token");
  });

  it("401 on a bare garbage token", async () => {
    addToken(ctx.db, { name: "reader", role: "read" });
    const res = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer("totally-bogus"));
    expect(res.status).toBe(401);
  });

  it("200 with a valid named read token (O(1) path)", async () => {
    const tok = addToken(ctx.db, { name: "reader", role: "read" });
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_name: "reader", role: "read" });
  });

  it("200 with a bare (legacy/bootstrap) token via capped scan", async () => {
    const raw = addBareToken(ctx.db, { name: "admin", role: "write" });
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(raw));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_name: "admin", role: "write" });
  });

  it("401 on a revoked token", async () => {
    const tok = addToken(ctx.db, { name: "reader", role: "read" });
    ctx.db.revokeToken("reader");
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Token has been revoked");
  });

  it("401 on an expired token", async () => {
    const tok = addToken(ctx.db, {
      name: "reader",
      role: "read",
      expiresAt: isoInPast(),
    });
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Token has expired");
  });

  it("accepts a not-yet-expired token", async () => {
    const tok = addToken(ctx.db, {
      name: "reader",
      role: "read",
      expiresAt: isoInFuture(),
    });
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(200);
  });

  it("read token cannot write (403)", async () => {
    const tok = addToken(ctx.db, { name: "reader", role: "read" });
    const res = await request(ctx.app)
      .post("/api/secrets")
      .set(bearer(tok))
      .send({ key: "K", value: "v" });
    expect(res.status).toBe(403);
  });

  it("does not 500 when a stored hash is truncated (length-guard)", async () => {
    // Corrupt a token's stored hash to a wrong length; auth must not RangeError-500.
    const tok = addToken(ctx.db, { name: "reader", role: "read" });
    ctx.db.db
      .prepare("UPDATE tokens SET token_hash = ? WHERE name = 'reader'")
      .run(Buffer.alloc(8));
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(tok));
    expect(res.status).toBe(401);
  });
});

describe("named-miss vs bare-scan (timing oracle fix)", () => {
  it("a bare token with NO dot still authenticates via the scan", async () => {
    const raw = addBareToken(ctx.db, { name: "boot", role: "write" });
    expect(raw.includes(".")).toBe(false);
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(raw));
    expect(res.status).toBe(200);
    expect(res.body.token_name).toBe("boot");
  });

  it("a well-formed named token with an unknown name → 401 (no scan fallback)", async () => {
    addToken(ctx.db, { name: "reader", role: "read" });
    const res = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer("nosuchname.deadbeefsecret"));
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe("Invalid token");
  });

  it("a bare token that CONTAINS a dot is treated as named and will not scan", async () => {
    // Documented caveat: raw/bootstrap tokens must not contain a '.'. Stored under
    // name 'dotted', but the raw wire value 'pfx.suffix' parses as named → looks up
    // name 'pfx' (absent) → 401, never reaching the scan that would have matched.
    const raw = addBareToken(ctx.db, {
      name: "dotted",
      role: "write",
      raw: "pfx.suffixvalue0123456789",
    });
    expect(raw.includes(".")).toBe(true);
    const res = await request(ctx.app).get("/api/auth/me").set(bearer(raw));
    expect(res.status).toBe(401);
  });

  it("caps the bare-token scan at 50: token past the cap → 401, within → 200", async () => {
    const tokens = [];
    for (let i = 0; i < 51; i += 1) {
      const name = `bare${String(i).padStart(2, "0")}`;
      tokens.push(
        addBareToken(ctx.db, {
          name,
          role: "write",
          raw: `scan-${name}-secretvalue0123456789`,
        }),
      );
    }
    // First inserted → within the first 50 scanned → authenticates.
    const within = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer(tokens[0]));
    expect(within.status).toBe(200);

    // 51st inserted → beyond the scan cap → never verified → 401.
    const past = await request(ctx.app)
      .get("/api/auth/me")
      .set(bearer(tokens[50]));
    expect(past.status).toBe(401);
  }, 30000);
});

describe("per-folder token scope", () => {
  it("denies reading a folder outside scope (403)", async () => {
    seedSecret(ctx.db, "FolderB", "SECRET_B", "b-value");
    const tok = addToken(ctx.db, {
      name: "svc",
      role: "read",
      scope: "FolderA",
    });
    const res = await request(ctx.app)
      .get("/api/secrets/FolderB/SECRET_B")
      .set(bearer(tok));
    expect(res.status).toBe(403);
    expect(res.body.detail).toBe("Token not scoped for folder 'FolderB'");
  });

  it("allows reading a folder inside scope", async () => {
    seedSecret(ctx.db, "FolderA", "SECRET_A", "a-value");
    const tok = addToken(ctx.db, {
      name: "svc",
      role: "read",
      scope: "FolderA",
    });
    const res = await request(ctx.app)
      .get("/api/secrets/FolderA/SECRET_A")
      .set(bearer(tok));
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("a-value");
  });

  it("list is filtered to scoped folders", async () => {
    seedSecret(ctx.db, "FolderA", "A", "1");
    seedSecret(ctx.db, "FolderB", "B", "2");
    const tok = addToken(ctx.db, {
      name: "svc",
      role: "read",
      scope: "FolderA",
    });
    const res = await request(ctx.app).get("/api/secrets").set(bearer(tok));
    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([{ key: "A", folder: "FolderA" }]);
  });

  it("wildcard scope sees all folders", async () => {
    seedSecret(ctx.db, "FolderA", "A", "1");
    seedSecret(ctx.db, "FolderB", "B", "2");
    const tok = addToken(ctx.db, { name: "svc", role: "read", scope: "*" });
    const res = await request(ctx.app).get("/api/secrets").set(bearer(tok));
    expect(res.body.keys).toHaveLength(2);
  });
});
