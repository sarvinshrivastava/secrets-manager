// Off-site copy: gzip + age encryption in process, then a GitHub release
// asset per slot. Nothing unencrypted leaves the process. Errors carry status
// codes only; nothing here logs a token, a URL or a GitHub-provided redirect.
import fs from "node:fs";
import zlib from "node:zlib";
import nodeCrypto from "node:crypto";
import { Readable, Transform, addAbortSignal, compose } from "node:stream";
import { Encrypter } from "age-encryption";
import { BackupError, networkErrorTag, redact } from "./errors.js";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const API_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const MAX_PAGES = 20;
const MESSAGE_MAX = 120;

// Streams file → gzip → age, hashing the ciphertext as it is produced. Every
// stage yields to the event loop per chunk, so the encryption never blocks
// the vault's request handling for long.
export async function encryptSnapshot(file, recipients, { signal } = {}) {
  let gzBytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      gzBytes += chunk.length;
      cb(null, chunk);
    },
  });
  const gz = compose(
    fs.createReadStream(file),
    zlib.createGzip({ level: 9 }),
    counter,
  );
  if (signal) addAbortSignal(signal, gz);

  const encrypter = new Encrypter();
  for (const r of recipients) encrypter.addRecipient(r);
  const out = await encrypter.encrypt(Readable.toWeb(gz));

  const hash = nodeCrypto.createHash("sha256");
  const chunks = [];
  for await (const chunk of out) {
    chunks.push(chunk);
    hash.update(chunk);
  }
  return {
    bytes: Buffer.concat(chunks),
    sha256: hash.digest("hex"),
    plainBytes: fs.statSync(file).size,
    gzBytes,
  };
}

const EXPIRY_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/;

export function parseTokenExpiration(value) {
  const m = EXPIRY_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const zone =
    m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function nextLink(header) {
  for (const part of String(header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

// Release a response body we do not read.
export async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

function statusError(res, op) {
  const s = res.status;
  const h = (k) => res.headers.get(k);
  let code;
  if (s === 429 || (s === 403 && (h("x-ratelimit-remaining") === "0" || h("retry-after")))) {
    code = "github_rate_limited";
  } else if (s === 401 || s === 403) {
    code = "github_auth";
  } else if (s === 404 && op === "getRelease") {
    code = "release_not_found";
  } else if (s >= 500) {
    code = "github_5xx";
  } else {
    code = "github_http";
  }
  return new BackupError(code, { status: s });
}

export function createGithubClient({
  owner,
  repo,
  tag,
  token,
  fetchImpl = fetch,
  log = console,
  signal,
}) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const base = `${API}${repoPath}`;
  let tokenExpiresAt = null;
  let expiryWarned = false;

  function signalFor(ms) {
    const t = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, t]) : t;
  }

  function noteExpiry(res) {
    const raw = res.headers.get("github-authentication-token-expiration");
    if (!raw) return;
    const d = parseTokenExpiration(raw);
    if (d) tokenExpiresAt = d;
    else if (!expiryWarned) {
      expiryWarned = true;
      log.warn("backup: unparsable token expiration header ignored");
    }
  }

  // `readBody: false` for the unauthenticated redirect hop: its body could
  // echo the signed URL, so only the status is logged.
  async function failWith(res, op, { readBody = true } = {}) {
    const err = statusError(res, op);
    let message = "";
    if (readBody) {
      try {
        const body = await res.text();
        message = JSON.parse(body)?.message ?? "";
      } catch {
        /* no JSON body */
      }
    } else {
      await discardBody(res);
    }
    const clean = redact(message, [token]).slice(0, MESSAGE_MAX);
    log.error(`backup: github ${op} failed: ${res.status} ${clean}`.trim());
    return err;
  }

  // An aborted run reports timeout; anything else is a logged network error.
  function networkFailure(op, err) {
    if (signal?.aborted) return new BackupError("timeout", { cause: err });
    log.error(`backup: github ${op} failed: ${networkErrorTag(err)}`);
    return new BackupError("github_network", { cause: err });
  }

  async function send(op, url, init, timeoutMs, { auth = true } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "secret-manager-backup",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    };
    let res;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers,
        signal: init.signal ?? signalFor(timeoutMs),
      });
    } catch (err) {
      throw networkFailure(op, err);
    }
    if (auth) noteExpiry(res);
    return res;
  }

  async function json(op, url, init = {}, timeoutMs = API_TIMEOUT_MS) {
    const res = await send(op, url, init, timeoutMs);
    if (!res.ok) throw await failWith(res, op);
    try {
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw new BackupError("timeout", { cause: err });
      throw new BackupError("github_network", { cause: err });
    }
  }

  return {
    get tokenExpiresAt() {
      return tokenExpiresAt;
    },

    async getRelease() {
      const rel = await json(
        "getRelease",
        `${base}/releases/tags/${encodeURIComponent(tag)}`,
        { method: "GET" },
      );
      return { id: rel.id };
    },

    async listAssets(releaseId) {
      let url = `${base}/releases/${releaseId}/assets?per_page=100`;
      const all = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await send("listAssets", url, { method: "GET" }, API_TIMEOUT_MS);
        if (!res.ok) throw await failWith(res, "listAssets");
        let items;
        try {
          items = await res.json();
        } catch (err) {
          throw networkFailure("listAssets", err);
        }
        if (!Array.isArray(items)) {
          log.error("backup: github listAssets failed: unexpected body");
          throw new BackupError("github_http");
        }
        all.push(...items);
        const next = nextLink(res.headers.get("link"));
        if (!next) return all;
        let parsed;
        try {
          parsed = new URL(next);
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.origin !== API) {
          log.error("backup: github listAssets failed: unexpected next-page origin");
          throw new BackupError("github_http");
        }
        url = parsed.toString();
      }
      log.error("backup: github listAssets failed: too many pages");
      throw new BackupError("github_http");
    },

    async uploadAsset(releaseId, name, bytes, sha256) {
      const u = new URL(`${UPLOADS}${repoPath}/releases/${releaseId}/assets`);
      u.searchParams.set("name", name);
      u.searchParams.set("label", `sha256-${sha256}`);
      return json(
        "uploadAsset",
        u.toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes,
        },
        TRANSFER_TIMEOUT_MS,
      );
    },

    async getAsset(id) {
      return json("getAsset", `${base}/releases/assets/${id}`, { method: "GET" });
    },

    async deleteAsset(id) {
      const res = await send(
        "deleteAsset",
        `${base}/releases/assets/${id}`,
        { method: "DELETE" },
        API_TIMEOUT_MS,
      );
      if (res.status === 204 || res.status === 404) {
        await discardBody(res);
        return;
      }
      throw await failWith(res, "deleteAsset");
    },

    // The redirect target is a signed, short-lived capability: it is fetched
    // once without Authorization and never logged.
    async downloadAssetSha256(id) {
      const download = {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal: signalFor(TRANSFER_TIMEOUT_MS), // one budget for both hops
      };
      let res = await send(
        "downloadAsset",
        `${base}/releases/assets/${id}`,
        { ...download, redirect: "manual" },
        TRANSFER_TIMEOUT_MS,
      );
      let followed = false;
      if (res.status >= 300 && res.status < 400) {
        followed = true;
        const location = res.headers.get("location");
        await discardBody(res);
        if (!location) throw new BackupError("github_http", { status: res.status });
        res = await send("downloadAsset", location, download, TRANSFER_TIMEOUT_MS, {
          auth: false,
        });
      }
      if (!res.ok) {
        throw await failWith(res, "downloadAsset", { readBody: !followed });
      }
      const hash = nodeCrypto.createHash("sha256");
      try {
        for await (const chunk of res.body) hash.update(chunk);
      } catch (err) {
        throw networkFailure("downloadAsset", err);
      }
      return hash.digest("hex");
    },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throws verify_mismatch only on a definite mismatch. A failed re-GET or
// download propagates its own github_* code, so the caller never deletes a
// possibly good asset because of a transient error.
export async function verifyAsset(
  client,
  asset,
  sha256,
  { expectedSize = null, sleep = defaultSleep } = {},
) {
  const mismatch = () => new BackupError("verify_mismatch");
  if (asset.state !== "uploaded") throw mismatch();
  if (expectedSize !== null && asset.size !== expectedSize) throw mismatch();
  if (asset.label !== `sha256-${sha256}`) throw mismatch();
  let digest = asset.digest ?? null;
  if (digest === null) {
    await sleep(2000);
    digest = (await client.getAsset(asset.id)).digest ?? null;
  }
  if (digest !== null) {
    if (digest !== `sha256:${sha256}`) throw mismatch();
    return;
  }
  const downloaded = await client.downloadAssetSha256(asset.id);
  if (downloaded !== sha256) throw mismatch();
}
