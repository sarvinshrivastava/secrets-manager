import crypto from "node:crypto";
import { Router } from "express";
import { isValidFolderName } from "../utils.js";

const TOKEN_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
// Clamp token lifetime — a huge expires_in_seconds (e.g. 1e20) overflows Date
// arithmetic and toISOString() throws → 500. 10 years is a sane ceiling.
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

function utcNowIso() {
  return new Date().toISOString();
}

// Validate + normalize a scope request into a CSV string. Accepts an array of
// folder names, or ["*"]/"*". Returns { csv } or { error }.
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return { csv: "*" };
  const list = Array.isArray(scope) ? scope : [scope];
  if (list.length === 0) return { csv: "*" };
  const cleaned = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { error: "scope entries must be non-empty strings" };
    }
    const name = entry.trim();
    if (name === "*") return { csv: "*" }; // wildcard subsumes everything
    if (!isValidFolderName(name)) {
      return { error: `invalid folder name in scope: ${name}` };
    }
    cleaned.push(name);
  }
  return { csv: [...new Set(cleaned)].join(",") };
}

export function createTokensRouter(
  db,
  cryptoManager,
  { requireAuth, requireWriteAccess, writeAudit },
) {
  const router = Router();

  // GET /api/tokens — list all tokens (no raw values)
  router.get("/", requireAuth, requireWriteAccess, (_req, res) => {
    const tokens = db.listTokens().map((row) => ({
      name: row.name,
      role: row.role,
      scope: row.scope || "*",
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at || null,
      revoked_at: row.revoked_at || null,
    }));
    res.json({ tokens });
  });

  // POST /api/tokens — create a new token (raw value returned once)
  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    const { name, role, expires_in_seconds, scope } = req.body || {};

    if (typeof name !== "string" || !TOKEN_NAME_REGEX.test(name)) {
      return res.status(400).json({
        detail:
          "Invalid token name. Use 1-64 characters: letters, numbers, hyphens, underscores.",
      });
    }

    if (role !== "read" && role !== "write") {
      return res.status(400).json({ detail: "Role must be 'read' or 'write'" });
    }

    const scopeResult = normalizeScope(scope);
    if (scopeResult.error) {
      return res.status(400).json({ detail: scopeResult.error });
    }

    const existing = db.getTokenByName(name);
    if (existing && !existing.revoked_at) {
      return res.status(409).json({ detail: `Token '${name}' already exists` });
    }

    let expiresAt = null;
    if (expires_in_seconds !== undefined) {
      if (!Number.isInteger(expires_in_seconds) || expires_in_seconds <= 0) {
        return res
          .status(400)
          .json({ detail: "expires_in_seconds must be a positive integer" });
      }
      const secs = Math.min(expires_in_seconds, MAX_EXPIRES_IN_SECONDS);
      const exp = new Date();
      exp.setSeconds(exp.getSeconds() + secs);
      expiresAt = exp.toISOString();
    }

    // Wire format: `<name>.<secret>`. The name is a non-secret lookup id that
    // lets auth verify a single PBKDF2 hash (O(1)) instead of scanning every
    // token. Only the secret half is hashed/stored.
    const rawSecret = crypto.randomBytes(32).toString("hex");
    const hashed = cryptoManager.hashToken(rawSecret);
    db.createToken(
      name,
      role,
      hashed.salt,
      hashed.digest,
      expiresAt,
      scopeResult.csv,
    );

    writeAudit(req, {
      action: "token_created",
      status: "ok",
      tokenName: req.auth.name,
      details: `name=${name} role=${role} scope=${scopeResult.csv}`,
    });

    res.status(201).json({
      name,
      role,
      scope: scopeResult.csv,
      token: `${name}.${rawSecret}`,
      expires_at: expiresAt,
    });
  });

  // DELETE /api/tokens/:name — revoke (tombstone)
  router.delete("/:name", requireAuth, requireWriteAccess, (req, res) => {
    const { name } = req.params;

    const row = db.getTokenByName(name);
    if (!row) {
      return res.status(404).json({ detail: `Token '${name}' not found` });
    }
    if (row.revoked_at) {
      return res
        .status(409)
        .json({ detail: `Token '${name}' is already revoked` });
    }

    // Prevent revoking the last active write token
    const activeWriteTokens = db
      .listTokens()
      .filter(
        (t) =>
          t.role === "write" &&
          !t.revoked_at &&
          (!t.expires_at || new Date() < new Date(t.expires_at)),
      );
    if (activeWriteTokens.length <= 1 && row.role === "write") {
      return res.status(409).json({
        detail:
          "Cannot revoke the last active write token — create another write token first",
      });
    }

    db.revokeToken(name);

    writeAudit(req, {
      action: "token_revoked",
      status: "ok",
      tokenName: req.auth.name,
      details: `revoked=${name}`,
    });

    res.json({ status: "revoked", name });
  });

  // POST /api/tokens/:name/rotate — in-place rotation (new hash, clear revoked_at)
  // Optional: { "token": "custom_hex_token_value" } — if provided and valid, uses custom token instead of generating random
  router.post("/:name/rotate", requireAuth, requireWriteAccess, (req, res) => {
    const { name } = req.params;
    const { token: customToken } = req.body || {};

    const row = db.getTokenByName(name);
    if (!row) {
      return res.status(404).json({ detail: `Token '${name}' not found` });
    }
    if (row.revoked_at) {
      return res
        .status(409)
        .json({ detail: `Token '${name}' is revoked and cannot be rotated` });
    }

    let rawToken;

    // If custom token provided, validate and use it
    if (customToken) {
      // Validate: must be hex string, 64+ characters (32+ bytes when decoded)
      if (typeof customToken !== "string") {
        return res.status(400).json({ detail: "Token must be a string" });
      }
      if (!/^[0-9a-fA-F]+$/.test(customToken)) {
        return res
          .status(400)
          .json({ detail: "Token must be a hexadecimal string" });
      }
      if (customToken.length < 64) {
        return res.status(400).json({
          detail: "Token must be at least 64 hexadecimal characters (32 bytes)",
        });
      }
      rawToken = customToken.toLowerCase();
    } else {
      // Generate random token
      rawToken = crypto.randomBytes(32).toString("hex");
    }

    // rawToken is the SECRET half; store its hash and hand the caller the full
    // `<name>.<secret>` wire token so it verifies via the O(1) named path.
    const hashed = cryptoManager.hashToken(rawToken);
    db.rotateToken(name, hashed.salt, hashed.digest);

    writeAudit(req, {
      action: "token_rotated",
      status: "ok",
      tokenName: req.auth.name,
      details: `rotated=${name}${customToken ? " (custom)" : " (random)"}`,
    });

    res.json({
      name,
      role: row.role,
      token: `${name}.${rawToken}`,
      expires_at: row.expires_at || null,
    });
  });

  return router;
}
