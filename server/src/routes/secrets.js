import { Router } from "express";
import {
  requireEnvKey,
  getClientIp,
  isValidFolderName,
  scopeAllowsFolder,
} from "../utils.js";
import { RateLimiter } from "../rate-limit.js";

const MAX_VALUE_BYTES = 32768;

function normalizeFolder(folder) {
  return typeof folder === "string" && folder.trim().length > 0
    ? folder.trim()
    : "Root";
}

export function createSecretsRouter(
  db,
  crypto,
  { requireAuth, requireWriteAccess, writeAudit },
  { publicRateLimitPerMinute, trustedProxyIps },
) {
  const router = Router();
  const publicRateLimiter = new RateLimiter(publicRateLimitPerMinute);

  function forbidFolder(res, folder) {
    return res
      .status(403)
      .json({ detail: `Token not scoped for folder '${folder}'` });
  }

  // GET /api/secrets — list all key+folder pairs (filtered to the token's scope)
  router.get("/", requireAuth, (req, res) => {
    const keys = db
      .listSecretKeys()
      .filter((row) => scopeAllowsFolder(req.auth.scope, row.folder));
    writeAudit(req, {
      action: "list_keys",
      status: "ok",
      tokenName: req.auth.name,
    });
    res.json({ keys });
  });

  // POST /api/secrets — create secret, immutable (409 if exists)
  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    const { key, value, folder } = req.body || {};

    if (
      typeof key !== "string" ||
      key.length < 1 ||
      key.length > 128 ||
      !requireEnvKey(key)
    ) {
      return res.status(400).json({
        detail:
          "Invalid key. Use environment-style names: letters, numbers, underscores, cannot start with a number.",
      });
    }

    if (typeof value !== "string" || value.length > MAX_VALUE_BYTES) {
      return res.status(400).json({ detail: "Invalid value" });
    }

    const folderName = normalizeFolder(folder);

    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ detail: "Invalid folder name" });
    }

    if (!scopeAllowsFolder(req.auth.scope, folderName)) {
      return forbidFolder(res, folderName);
    }

    const encrypted = crypto.encryptValue(value);
    const created = db.createSecret(
      folderName,
      key,
      encrypted.nonce,
      encrypted.ciphertext,
    );

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

  // POST /api/secrets/bulk — transactional multi-create/update, scope-checked.
  // Body: { folder, secrets: [{key, value}], overwrite: [key] }
  router.post("/bulk", requireAuth, requireWriteAccess, (req, res) => {
    const { folder, secrets, overwrite } = req.body || {};

    const folderName = normalizeFolder(folder);
    if (!isValidFolderName(folderName)) {
      return res.status(400).json({ detail: "Invalid folder name" });
    }
    if (!scopeAllowsFolder(req.auth.scope, folderName)) {
      return forbidFolder(res, folderName);
    }
    if (!Array.isArray(secrets)) {
      return res.status(400).json({ detail: "secrets must be an array" });
    }
    const overwriteSet = new Set(Array.isArray(overwrite) ? overwrite : []);

    const added = [];
    const updated = [];
    const skipped = [];
    const invalid = [];

    // All-or-nothing: any thrown error rolls the whole batch back. Invalid
    // entries are collected (not thrown) so a bad key doesn't discard good ones.
    const bulkTx = db.db.transaction(() => {
      for (const entry of secrets) {
        const key = entry?.key;
        const value = entry?.value;

        if (
          typeof key !== "string" ||
          key.length < 1 ||
          key.length > 128 ||
          !requireEnvKey(key)
        ) {
          invalid.push({
            key: typeof key === "string" ? key : null,
            reason: "invalid key",
          });
          continue;
        }
        if (typeof value !== "string" || value.length > MAX_VALUE_BYTES) {
          invalid.push({ key, reason: "invalid value" });
          continue;
        }

        const existing = db.getSecret(folderName, key);
        const encrypted = crypto.encryptValue(value);

        if (existing) {
          if (overwriteSet.has(key)) {
            db.updateSecret(
              folderName,
              key,
              encrypted.nonce,
              encrypted.ciphertext,
            );
            updated.push(key);
            writeAudit(req, {
              action: "secret_updated",
              status: "ok",
              tokenName: req.auth.name,
              keyName: key,
              details: `folder=${folderName}`,
            });
          } else {
            skipped.push(key);
          }
        } else {
          db.createSecret(
            folderName,
            key,
            encrypted.nonce,
            encrypted.ciphertext,
          );
          added.push(key);
          writeAudit(req, {
            action: "secret_created",
            status: "ok",
            tokenName: req.auth.name,
            keyName: key,
            details: `folder=${folderName}`,
          });
        }
      }
    });

    bulkTx();

    res
      .status(207)
      .json({ added, updated, skipped, invalid, folder: folderName });
  });

  // GET /api/secrets/:folder/:key — public-facing, folder-scoped (own rate limiter)
  router.get(
    "/:folder/:key",
    (req, res, next) => {
      const ip = getClientIp(req, trustedProxyIps);
      const { allowed, retryAfter } = publicRateLimiter.allow(ip);
      if (!allowed) {
        db.insertAuditLog({
          tokenName: null,
          action: "rate_limit",
          keyName: null,
          status: "blocked",
          ipAddress: ip,
          details: "Public endpoint per-IP limit exceeded",
        });
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({ detail: "Rate limit exceeded" });
      }
      return next();
    },
    requireAuth,
    (req, res) => {
      const { folder, key } = req.params;

      if (!requireEnvKey(key)) {
        return res.status(400).json({ detail: "Invalid key format" });
      }

      if (!scopeAllowsFolder(req.auth.scope, folder)) {
        return forbidFolder(res, folder);
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
        return res.json({
          key,
          value,
          folder: row.folder,
          created_at: row.created_at,
        });
      } catch (error) {
        console.error(`Failed to decrypt key: ${key}`, error);
        writeAudit(req, {
          action: "get_secret",
          status: "error",
          tokenName: req.auth.name,
          keyName: key,
          details: "Decrypt failure",
        });
        return res
          .status(500)
          .json({ detail: "Stored value could not be decrypted" });
      }
    },
  );

  // DELETE /api/secrets/:folder/:key — write auth, internal
  router.delete(
    "/:folder/:key",
    requireAuth,
    requireWriteAccess,
    (req, res) => {
      const { folder, key } = req.params;

      if (!requireEnvKey(key)) {
        return res.status(400).json({ detail: "Invalid key format" });
      }

      if (!scopeAllowsFolder(req.auth.scope, folder)) {
        return forbidFolder(res, folder);
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
    },
  );

  return router;
}
