import crypto from "node:crypto";
import { Router } from "express";

const TOKEN_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function utcNowIso() {
  return new Date().toISOString();
}

export function createTokensRouter(db, cryptoManager, { requireAuth, requireWriteAccess, writeAudit }) {
  const router = Router();

  // GET /api/tokens — list all tokens (no raw values)
  router.get("/", requireAuth, requireWriteAccess, (_req, res) => {
    const tokens = db.listTokens().map((row) => ({
      name: row.name,
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at || null,
      revoked_at: row.revoked_at || null,
    }));
    res.json({ tokens });
  });

  // POST /api/tokens — create a new token (raw value returned once)
  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    const { name, role, expires_in_seconds } = req.body || {};

    if (typeof name !== "string" || !TOKEN_NAME_REGEX.test(name)) {
      return res.status(400).json({
        detail: "Invalid token name. Use 1-64 characters: letters, numbers, hyphens, underscores.",
      });
    }

    if (role !== "read" && role !== "write") {
      return res.status(400).json({ detail: "Role must be 'read' or 'write'" });
    }

    const existing = db.getTokenByName(name);
    if (existing && !existing.revoked_at) {
      return res.status(409).json({ detail: `Token '${name}' already exists` });
    }

    let expiresAt = null;
    if (expires_in_seconds !== undefined) {
      const secs = Number(expires_in_seconds);
      if (!Number.isFinite(secs) || secs <= 0) {
        return res.status(400).json({ detail: "expires_in_seconds must be a positive number" });
      }
      const exp = new Date();
      exp.setSeconds(exp.getSeconds() + secs);
      expiresAt = exp.toISOString();
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashed = cryptoManager.hashToken(rawToken);
    db.createToken(name, role, hashed.salt, hashed.digest, expiresAt);

    writeAudit(req, {
      action: "token_created",
      status: "ok",
      tokenName: req.auth.name,
      details: `name=${name} role=${role}`,
    });

    res.status(201).json({ name, role, token: rawToken, expires_at: expiresAt });
  });

  // DELETE /api/tokens/:name — revoke (tombstone)
  router.delete("/:name", requireAuth, requireWriteAccess, (req, res) => {
    const { name } = req.params;

    const row = db.getTokenByName(name);
    if (!row) {
      return res.status(404).json({ detail: `Token '${name}' not found` });
    }
    if (row.revoked_at) {
      return res.status(409).json({ detail: `Token '${name}' is already revoked` });
    }

    // Prevent revoking the last active write token
    const activeWriteTokens = db.listTokens().filter(
      (t) => t.role === "write" && !t.revoked_at && (!t.expires_at || new Date() < new Date(t.expires_at)),
    );
    if (activeWriteTokens.length <= 1 && row.role === "write") {
      return res.status(409).json({
        detail: "Cannot revoke the last active write token — create another write token first",
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
      return res.status(409).json({ detail: `Token '${name}' is revoked and cannot be rotated` });
    }

    let rawToken;

    // If custom token provided, validate and use it
    if (customToken) {
      // Validate: must be hex string, 64+ characters (32+ bytes when decoded)
      if (typeof customToken !== "string") {
        return res.status(400).json({ detail: "Token must be a string" });
      }
      if (!/^[0-9a-fA-F]+$/.test(customToken)) {
        return res.status(400).json({ detail: "Token must be a hexadecimal string" });
      }
      if (customToken.length < 64) {
        return res.status(400).json({ detail: "Token must be at least 64 hexadecimal characters (32 bytes)" });
      }
      rawToken = customToken.toLowerCase();
    } else {
      // Generate random token
      rawToken = crypto.randomBytes(32).toString("hex");
    }

    const hashed = cryptoManager.hashToken(rawToken);
    db.rotateToken(name, hashed.salt, hashed.digest);

    writeAudit(req, {
      action: "token_rotated",
      status: "ok",
      tokenName: req.auth.name,
      details: `rotated=${name}${customToken ? " (custom)" : " (random)"}`,
    });

    res.json({ name, role: row.role, token: rawToken, expires_at: row.expires_at || null });
  });

  return router;
}
