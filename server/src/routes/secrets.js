import { Router } from "express";
import {
  requireEnvKey,
  getClientIp,
  isValidFolderName,
  scopeAllowsFolder,
} from "../utils.js";
import { RateLimiter } from "../rate-limit.js";

const MAX_VALUE_BYTES = 32768;
// Cap bulk batch size so a single request can't queue an unbounded number of
// encrypt+insert operations inside one transaction (memory / event-loop DoS).
const MAX_BULK_ENTRIES = 500;

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

    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
    ) {
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
    if (secrets.length > MAX_BULK_ENTRIES) {
      return res.status(400).json({
        detail: `Too many entries: max ${MAX_BULK_ENTRIES} per bulk request`,
      });
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
        if (
          typeof value !== "string" ||
          Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES
        ) {
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

      // Before the scope check and any audit write: the folder is echoed into
      // audit details (`folder=<F>`), so arbitrary bytes must never reach them.
      if (!isValidFolderName(folder)) {
        return res.status(400).json({ detail: "Invalid folder name" });
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
          details: `folder=${folder}`,
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
          details: `folder=${folder}`,
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
          details: `folder=${folder} Decrypt failure`,
        });
        return res
          .status(500)
          .json({ detail: "Stored value could not be decrypted" });
      }
    },
  );

  // PATCH /api/secrets/:folder/:key — rename and/or move and/or replace the
  // value (write auth, internal). Body: { key?, folder?, value? }; every present
  // field must be a string. Order: parse -> validate -> scope(source) ->
  // scope(target) -> load source (404) -> no-op -> write (409 on UNIQUE).
  router.patch("/:folder/:key", requireAuth, requireWriteAccess, (req, res) => {
    const { folder: fromFolder, key: fromKey } = req.params;
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};
    const has = (name) => Object.hasOwn(body, name);

    if (!has("key") && !has("folder") && !has("value")) {
      return res.status(400).json({ detail: "Nothing to update" });
    }
    if (!requireEnvKey(fromKey)) {
      return res.status(400).json({ detail: "Invalid key format" });
    }

    let toKey = fromKey;
    if (has("key")) {
      toKey = body.key;
      if (
        typeof toKey !== "string" ||
        toKey.length < 1 ||
        toKey.length > 128 ||
        !requireEnvKey(toKey)
      ) {
        return res.status(400).json({
          detail:
            "Invalid key. Use environment-style names: letters, numbers, underscores, cannot start with a number.",
        });
      }
    }

    let toFolder = fromFolder;
    if (has("folder")) {
      // No Root fallback here: a blank folder is a 400, not "Root".
      toFolder = typeof body.folder === "string" ? body.folder.trim() : null;
      if (!toFolder || !isValidFolderName(toFolder)) {
        return res.status(400).json({ detail: "Invalid folder name" });
      }
    }

    const valuePresent = has("value");
    if (
      valuePresent &&
      (typeof body.value !== "string" ||
        Buffer.byteLength(body.value, "utf8") > MAX_VALUE_BYTES)
    ) {
      return res.status(400).json({ detail: "Invalid value" });
    }

    if (!scopeAllowsFolder(req.auth.scope, fromFolder)) {
      return forbidFolder(res, fromFolder);
    }
    if (!scopeAllowsFolder(req.auth.scope, toFolder)) {
      return forbidFolder(res, toFolder);
    }

    const notFound = () => {
      writeAudit(req, {
        action: "secret_edited",
        status: "missing",
        tokenName: req.auth.name,
        keyName: fromKey,
      });
      return res.status(404).json({ detail: "Secret not found" });
    };
    const conflict = () =>
      res.status(409).json({
        detail: `Secret '${toKey}' already exists in folder '${toFolder}'`,
      });

    if (!db.getSecret(fromFolder, fromKey)) return notFound();

    const moved = toKey !== fromKey || toFolder !== fromFolder;
    if (!moved && !valuePresent) {
      return res.json({ status: "ok", key: toKey, folder: toFolder });
    }
    if (moved && db.getSecret(toFolder, toKey)) return conflict();

    const encrypted = valuePresent ? crypto.encryptValue(body.value) : null;
    // Edit + audit row in ONE transaction: a failed audit insert rolls the edit
    // back (500, nothing changed) instead of leaving an unaudited rename/move.
    const editTx = db.db.transaction(() => {
      if (!db.editSecret(fromFolder, fromKey, toFolder, toKey, encrypted)) {
        return false;
      }
      writeAudit(req, {
        action: "secret_edited",
        status: "ok",
        tokenName: req.auth.name,
        keyName: toKey,
        details: `from=${fromFolder}|${fromKey} to=${toFolder}|${toKey} value_changed=${valuePresent}`,
      });
      return true;
    });
    let updated;
    try {
      updated = editTx();
    } catch (err) {
      if (
        err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        err.code === "SQLITE_CONSTRAINT"
      ) {
        return conflict();
      }
      throw err;
    }
    if (!updated) return notFound();

    return res.json({ status: "ok", key: toKey, folder: toFolder });
  });

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
