import { Router } from "express";
import { requireEnvKey, getClientIp } from "../utils.js";
import { RateLimiter } from "../rate-limit.js";

export function createSecretsRouter(
  db,
  crypto,
  { requireAuth, requireWriteAccess, writeAudit },
  { publicRateLimitPerMinute, trustedProxyIps },
) {
  const router = Router();
  const publicRateLimiter = new RateLimiter(publicRateLimitPerMinute);

  // GET /api/secrets — list all key+folder pairs (internal, read auth)
  router.get("/", requireAuth, (req, res) => {
    const keys = db.listSecretKeys();
    writeAudit(req, { action: "list_keys", status: "ok", tokenName: req.auth.name });
    res.json({ keys });
  });

  // POST /api/secrets — create secret, immutable (409 if exists)
  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    const { key, value, folder } = req.body || {};

    if (typeof key !== "string" || key.length < 1 || key.length > 128 || !requireEnvKey(key)) {
      return res.status(400).json({
        detail:
          "Invalid key. Use environment-style names: letters, numbers, underscores, cannot start with a number.",
      });
    }

    if (typeof value !== "string" || value.length > 32768) {
      return res.status(400).json({ detail: "Invalid value" });
    }

    const folderName =
      typeof folder === "string" && folder.trim().length > 0 ? folder.trim() : "Root";

    const encrypted = crypto.encryptValue(value);
    const created = db.createSecret(folderName, key, encrypted.nonce, encrypted.ciphertext);

    if (!created) {
      return res.status(409).json({
        detail: `Secret '${key}' already exists in folder '${folderName}'. Delete it first to replace.`,
      });
    }

    writeAudit(req, {
      action: "secret_created",
      status: "ok",
      tokenName: req.auth.name,
      keyName: key,
      details: `folder=${folderName}`,
    });

    res.json({ status: "ok", key, folder: folderName });
  });

  // GET /api/secrets/:folder/:key — public-facing, folder-scoped (own rate limiter)
  router.get("/:folder/:key", (req, res, next) => {
    const ip = getClientIp(req, trustedProxyIps);
    if (!publicRateLimiter.allow(ip)) {
      db.insertAuditLog({
        tokenName: null,
        action: "rate_limit",
        keyName: null,
        status: "blocked",
        ipAddress: ip,
        details: "Public endpoint per-IP limit exceeded",
      });
      return res.status(429).json({ detail: "Rate limit exceeded" });
    }
    return next();
  }, requireAuth, (req, res) => {
    const { folder, key } = req.params;

    if (!requireEnvKey(key)) {
      return res.status(400).json({ detail: "Invalid key format" });
    }

    const row = db.getSecret(folder, key);
    if (!row) {
      writeAudit(req, {
        action: "get_secret",
        status: "missing",
        tokenName: req.auth.name,
        keyName: key,
      });
      return res.status(404).json({ detail: "Secret not found" });
    }

    try {
      const value = crypto.decryptValue(row.nonce, row.ciphertext);
      writeAudit(req, {
        action: "get_secret",
        status: "ok",
        tokenName: req.auth.name,
        keyName: key,
      });
      return res.json({ key, value, folder: row.folder, created_at: row.created_at });
    } catch (error) {
      console.error(`Failed to decrypt key: ${key}`, error);
      writeAudit(req, {
        action: "get_secret",
        status: "error",
        tokenName: req.auth.name,
        keyName: key,
        details: "Decrypt failure",
      });
      return res.status(500).json({ detail: "Stored value could not be decrypted" });
    }
  });

  // DELETE /api/secrets/:folder/:key — write auth, internal
  router.delete("/:folder/:key", requireAuth, requireWriteAccess, (req, res) => {
    const { folder, key } = req.params;

    if (!requireEnvKey(key)) {
      return res.status(400).json({ detail: "Invalid key format" });
    }

    const deleted = db.deleteSecret(folder, key);
    if (!deleted) {
      writeAudit(req, {
        action: "secret_deleted",
        status: "missing",
        tokenName: req.auth.name,
        keyName: key,
      });
      return res.status(404).json({ detail: "Secret not found" });
    }

    writeAudit(req, {
      action: "secret_deleted",
      status: "ok",
      tokenName: req.auth.name,
      keyName: key,
    });

    return res.json({ status: "deleted", key, folder });
  });

  return router;
}
