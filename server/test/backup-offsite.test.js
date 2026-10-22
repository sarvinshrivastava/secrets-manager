import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import {
  Encrypter,
  Decrypter,
  generateIdentity,
  identityToRecipient,
} from "age-encryption";
import {
  encryptSnapshot,
  createGithubClient,
  verifyAsset,
  parseTokenExpiration,
} from "../src/backup/offsite.js";

const TOKEN = "github_pat_SECRETVALUE_0123456789";
const LOCATION = "https://objects.githubusercontent.com/signed?X-Amz-Signature=SIGNEDCAP";
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

function captureLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(" "));
  return { lines, log: { info: push, warn: push, error: push } };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, impl };
}

const jsonRes = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(handler, extra = {}) {
  const f = fakeFetch(handler);
  const { lines, log } = captureLog();
  const c = createGithubClient({
    owner: "someone",
    repo: "vault-backups",
    tag: "daily",
    token: TOKEN,
    fetchImpl: f.impl,
    log,
    ...extra,
  });
  return { c, calls: f.calls, lines };
}

function expectClean(lines, calls = []) {
  for (const l of lines) {
    expect(l).not.toContain(TOKEN);
    expect(l).not.toContain("SIGNEDCAP");
  }
  for (const c of calls) expect(c.url).not.toContain(TOKEN);
}

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sm-offsite-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("age-encryption dependency", () => {
  it("exports the encrypt/decrypt API", () => {
    expect(typeof Encrypter).toBe("function");
    expect(typeof Decrypter).toBe("function");
    expect(typeof generateIdentity).toBe("function");
  });
});

describe("encryptSnapshot", () => {
  it("round-trips through age and gunzip, hashing the ciphertext", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const file = path.join(root, "plain.db");
    const plain = Buffer.concat([nodeCrypto.randomBytes(200_000), Buffer.alloc(300_000, 7)]);
    fs.writeFileSync(file, plain);
    const res = await encryptSnapshot(file, [
      await identityToRecipient(id1),
      await identityToRecipient(id2),
    ]);
    expect(res.sha256).toBe(sha(res.bytes));
    expect(res.plainBytes).toBe(plain.length);
    expect(res.gzBytes).toBeGreaterThan(0);
    expect(res.gzBytes).toBeLessThan(plain.length);
    for (const id of [id1, id2]) {
      const d = new Decrypter();
      d.addIdentity(id);
      const gz = await d.decrypt(new Uint8Array(res.bytes));
      expect(zlib.gunzipSync(gz).equals(plain)).toBe(true);
    }
  });

  for (const [label, p] of [
    ["a directory (EISDIR)", () => root],
    ["a nonexistent path (ENOENT)", () => path.join(root, "nope.db")],
  ]) {
    it(`rejects for ${label} instead of hanging`, async () => {
      const r = await identityToRecipient(await generateIdentity());
      const outcome = await Promise.race([
        encryptSnapshot(p(), [r]).then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((res) => setTimeout(() => res("hung"), 2000)),
      ]);
      expect(outcome).toBe("rejected");
    });
  }
});

describe("github client", () => {
  it("maps a tag 404 to release_not_found", async () => {
    const { c, calls, lines } = client(() => jsonRes({ message: "Not Found" }, 404));
    await expect(c.getRelease()).rejects.toMatchObject({ code: "release_not_found" });
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/someone/vault-backups/releases/tags/daily",
    );
    const h = calls[0].init.headers;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expectClean(lines, calls);
  });

  it("returns the release id", async () => {
    const { c } = client(() => jsonRes({ id: 42, upload_url: "https://x/{?name,label}" }));
    expect(await c.getRelease()).toEqual({ id: 42 });
  });

  it("merges a three-page Link listing", async () => {
    const page = (n, count) =>
      Array.from({ length: count }, (_, i) => ({ id: n * 1000 + i }));
    const { c, calls } = client((url) => {
      const u = new URL(url);
      const p = Number(u.searchParams.get("page") ?? 1);
      const link =
        p < 3
          ? `<https://api.github.com/repositories/1/releases/42/assets?per_page=100&page=${p + 1}>; rel="next", <https://api.github.com/x?page=3>; rel="last"`
          : `<https://api.github.com/x?page=1>; rel="first"`;
      return jsonRes(page(p, p < 3 ? 50 : 50), 200, { link });
    });
    const all = await c.listAssets(42);
    expect(all).toHaveLength(150);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0].url).searchParams.get("per_page")).toBe("100");
  });

  it("refuses a next page on a foreign origin without requesting it", async () => {
    const { c, calls } = client(() =>
      jsonRes([{ id: 1 }], 200, { link: '<https://evil.example/steal>; rel="next"' }),
    );
    await expect(c.listAssets(42)).rejects.toMatchObject({ code: "github_http" });
    expect(calls).toHaveLength(1);
    expect(calls.some((x) => x.url.includes("evil"))).toBe(false);
  });

  it("builds the upload URL from parts", async () => {
    const bytes = Buffer.from("cipher");
    const { c, calls } = client(() => jsonRes({ id: 7, state: "uploaded" }, 201));
    await c.uploadAsset(42, "secrets-20261020.db.gz.age", bytes, "ab".repeat(32));
    const u = new URL(calls[0].url);
    expect(u.host).toBe("uploads.github.com");
    expect(u.pathname).toBe("/repos/someone/vault-backups/releases/42/assets");
    expect(u.searchParams.get("name")).toBe("secrets-20261020.db.gz.age");
    expect(u.searchParams.get("label")).toBe(`sha256-${"ab".repeat(32)}`);
    expect(calls[0].url).not.toContain("{");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls[0].init.body).toBe(bytes);
  });

  for (const [status, headers, code] of [
    [401, {}, "github_auth"],
    [403, {}, "github_auth"],
    [403, { "x-ratelimit-remaining": "0" }, "github_rate_limited"],
    [403, { "retry-after": "60" }, "github_rate_limited"],
    [429, {}, "github_rate_limited"],
    [502, {}, "github_5xx"],
    [418, {}, "github_http"],
    [422, {}, "github_http"],
  ]) {
    it(`maps ${status} ${JSON.stringify(headers)} to ${code}`, async () => {
      const { c, lines } = client(() =>
        jsonRes({ message: `bad ${TOKEN} thing` }, status, headers),
      );
      const err = await c.getAsset(1).catch((e) => e);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe(code);
      expect(lines.join("\n")).toContain("[redacted]");
      expectClean(lines);
    });
  }

  it("maps a fetch TypeError to github_network without logging its message", async () => {
    const { c, lines } = client(() => {
      throw new TypeError(`fetch failed for ${LOCATION}`, {
        cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
      });
    });
    await expect(c.getRelease()).rejects.toMatchObject({ code: "github_network" });
    expect(lines.join("\n")).toContain("ECONNRESET");
    expectClean(lines);
  });

  it("maps a non-array listing body to github_http", async () => {
    const { c } = client(() => jsonRes({ message: "odd" }));
    await expect(c.listAssets(42)).rejects.toMatchObject({ code: "github_http" });
  });

  it("logs only the status when the unauthenticated redirect hop fails", async () => {
    const { c, lines } = client((url) => {
      if (url === LOCATION) return jsonRes({ message: `denied ${LOCATION}` }, 403);
      return new Response(null, { status: 302, headers: { location: LOCATION } });
    });
    await expect(c.downloadAssetSha256(9)).rejects.toMatchObject({ code: "github_auth" });
    expect(lines.join("\n")).toContain("downloadAsset failed: 403");
    expect(lines.join("\n")).not.toContain("denied");
    expectClean(lines);
  });

  it("treats delete 204 and 404 as done", async () => {
    let status = 204;
    const { c, calls } = client(() => new Response(null, { status }));
    await c.deleteAsset(5);
    status = 404;
    await c.deleteAsset(5);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/someone/vault-backups/releases/assets/5",
    );
  });

  it("parses the token expiration header", async () => {
    const { c } = client(() =>
      jsonRes({ id: 1 }, 200, {
        "github-authentication-token-expiration": "2026-11-01 12:00:00 UTC",
      }),
    );
    await c.getRelease();
    expect(c.tokenExpiresAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(parseTokenExpiration("2026-11-01 12:00:00 +0530").toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
    expect(parseTokenExpiration("next tuesday")).toBeNull();
  });

  it("ignores a garbage expiration header with one log line", async () => {
    const { c, lines } = client(() =>
      jsonRes({ id: 1 }, 200, { "github-authentication-token-expiration": "soon" }),
    );
    await c.getRelease();
    await c.getRelease();
    expect(c.tokenExpiresAt).toBeNull();
    expect(lines.filter((l) => l.includes("expiration"))).toHaveLength(1);
  });
});

describe("verifyAsset", () => {
  const hex = "c".repeat(64);
  const asset = (extra = {}) => ({
    id: 9,
    state: "uploaded",
    size: 100,
    label: `sha256-${hex}`,
    digest: `sha256:${hex}`,
    ...extra,
  });
  const noSleep = { sleep: async () => {} };

  it("passes on a matching digest", async () => {
    const { c, calls } = client(() => jsonRes({}));
    await verifyAsset(c, asset(), hex, { expectedSize: 100, ...noSleep });
    expect(calls).toHaveLength(0);
  });

  for (const [label, extra, opts] of [
    ["digest mismatch", { digest: `sha256:${"d".repeat(64)}` }, {}],
    ["starter state", { state: "starter" }, {}],
    ["wrong size", {}, { expectedSize: 101 }],
    ["wrong label", { label: "sha256-" + "e".repeat(64) }, {}],
  ]) {
    it(`throws verify_mismatch on ${label}`, async () => {
      const { c } = client(() => jsonRes({}));
      await expect(
        verifyAsset(c, asset(extra), hex, { ...opts, ...noSleep }),
      ).rejects.toMatchObject({ code: "verify_mismatch" });
    });
  }

  it("ignores size on reconcile (expected size unknown)", async () => {
    const { c } = client(() => jsonRes({}));
    await verifyAsset(c, asset({ size: 5 }), hex, noSleep);
  });

  it("re-GETs once, then downloads without Authorization on the redirect hop", async () => {
    const body = Buffer.from("ciphertext-bytes");
    const want = sha(body);
    const { c, calls, lines } = client((url, init) => {
      if (url.endsWith("/releases/assets/9") && init.headers.Accept === "application/vnd.github+json") {
        return jsonRes(asset({ digest: null, label: `sha256-${want}` }));
      }
      if (url.endsWith("/releases/assets/9")) {
        return new Response(null, { status: 302, headers: { location: LOCATION } });
      }
      return new Response(body, { status: 200 });
    });
    await verifyAsset(c, asset({ digest: null, label: `sha256-${want}` }), want, noSleep);
    expect(calls).toHaveLength(3);
    expect(calls[1].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].init.redirect).toBe("manual");
    expect(calls[1].init.headers.Accept).toBe("application/octet-stream");
    expect(calls[2].url).toBe(LOCATION);
    expect(calls[2].init.headers.Authorization).toBeUndefined();
    expectClean(lines);
  });

  it("throws verify_mismatch when the downloaded hash differs", async () => {
    const { c } = client((url, init) => {
      if (init.headers.Accept === "application/vnd.github+json") return jsonRes(asset({ digest: null }));
      return new Response(Buffer.from("other"), { status: 200 });
    });
    await expect(verifyAsset(c, asset({ digest: null }), hex, noSleep)).rejects.toMatchObject({
      code: "verify_mismatch",
    });
  });

  it("propagates github_network (not verify_mismatch) when the download fails", async () => {
    const { c, lines } = client((url, init) => {
      if (init.headers.Accept === "application/vnd.github+json") return jsonRes(asset({ digest: null }));
      if (url === LOCATION) throw new TypeError(`fetch failed ${LOCATION}`);
      return new Response(null, { status: 302, headers: { location: LOCATION } });
    });
    await expect(verifyAsset(c, asset({ digest: null }), hex, noSleep)).rejects.toMatchObject({
      code: "github_network",
    });
    expectClean(lines);
  });
});
