import crypto from "node:crypto";
import { Router } from "express";
import {
  isValidFolderName,
  scopeIsSubset,
  TOKEN_NAME_REGEX,
} from "../utils.js";

// Clamp token lifetime — a huge expires_in_seconds (e.g. 1e20) overflows Date
// arithmetic and toISOString() throws → 500. 10 years is a sane ceiling.
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

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

  // GET /api/tokens — list tokens (no raw values). Filtered to tokens whose
  // scope is a subset of the caller's — a folder-scoped admin never sees tokens
  // (e.g. the global `admin`) that outrank it.
  router.get("/", requireAuth, requireWriteAccess, (req, res) => {
    const tokens = db
      .listTokens()
      .filter((row) => scopeIsSubset(row.scope || "*", req.auth.scope || "*"))
      .map((row) => ({
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

    const callerScope = req.auth.scope || "*";

    // Default: admin (`*`) → `*`, a scoped caller → its OWN scope (never widen an
    // unscoped request to `*` for a non-admin).
    let scopeResult;
    if (scope === undefined || scope === null) {
      scopeResult = { csv: callerScope };
    } else {
      scopeResult = normalizeScope(scope);
      if (scopeResult.error) {
        return res.status(400).json({ detail: scopeResult.error });
      }
    }

    // Subset model: a caller may only grant a scope contained in its own.
    if (!scopeIsSubset(scopeResult.csv, callerScope)) {
      return res
        .status(403)
        .json({ detail: "Cannot grant scope beyond your own" });
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

    // Subset model: may only manage a token whose scope ⊆ the caller's scope.
    if (!scopeIsSubset(row.scope || "*", req.auth.scope || "*")) {
      return res
        .status(403)
        .json({ detail: "Cannot manage a token beyond your scope" });
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

  // POST /api/tokens/:name/rotate — in-place rotation (new hash, clear revoked_at).
  // The new secret is ALWAYS server-random; any caller-supplied `token` in the
  // body is ignored (owner decision — no caller-chosen token material).
  router.post("/:name/rotate", requireAuth, requireWriteAccess, (req, res) => {
    const { name } = req.params;

    const row = db.getTokenByName(name);
    if (!row) {
      return res.status(404).json({ detail: `Token '${name}' not found` });
    }
    if (row.revoked_at) {
      return res
        .status(409)
        .json({ detail: `Token '${name}' is revoked and cannot be rotated` });
    }

    // Subset model: may only manage a token whose scope ⊆ the caller's scope.
    if (!scopeIsSubset(row.scope || "*", req.auth.scope || "*")) {
      return res
        .status(403)
        .json({ detail: "Cannot manage a token beyond your scope" });
    }

    // Always generate a fresh server-random secret. rawToken is the SECRET half;
    // store its hash and hand the caller the full `<name>.<secret>` wire token so
    // it verifies via the O(1) named path.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashed = cryptoManager.hashToken(rawToken);
    db.rotateToken(name, hashed.salt, hashed.digest);

    writeAudit(req, {
      action: "token_rotated",
      status: "ok",
      tokenName: req.auth.name,
      details: `rotated=${name}`,
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
