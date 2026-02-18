import { Router } from "express";
import express from "express";
import { requireEnvKey, parseEnvValue } from "../utils.js";

export function createImportRouter(db, crypto, { requireAuth, requireWriteAccess, writeAudit }) {
  const router = Router();

  router.use(express.text({ type: "text/plain", limit: "512kb" }));

  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    if (typeof req.body !== "string") {
      return res.status(400).json({ detail: "Expected text/plain body" });
    }

    let imported = 0;
    let skipped = 0;
    const lines = req.body.split(/\r?\n/);

    const pairs = [];
    for (let i = 0; i < lines.length; i += 1) {
      let stripped = lines[i].trim();
      const lineNumber = i + 1;

      if (!stripped || stripped.startsWith("#")) continue;

      if (stripped.startsWith("export ")) {
        stripped = stripped.slice(7).trim();
      }

      const equalIndex = stripped.indexOf("=");
      if (equalIndex < 0) {
        return res.status(400).json({ detail: `Invalid .env line at ${lineNumber}: missing '='` });
      }

      const key = stripped.slice(0, equalIndex).trim();
      const rawValue = stripped.slice(equalIndex + 1);

      if (!requireEnvKey(key)) {
        return res.status(400).json({ detail: `Invalid key at line ${lineNumber}: ${key}` });
      }

      pairs.push({ key, value: parseEnvValue(rawValue), folder: "Root" });
    }

    // Wrap in transaction — all-or-nothing
    const importTx = db.db.transaction((entries) => {
      for (const { key, value, folder } of entries) {
        const encrypted = crypto.encryptValue(value);
        const created = db.createSecret(folder, key, encrypted.nonce, encrypted.ciphertext);
        if (created) {
          imported += 1;
        } else {
          skipped += 1;
        }
      }
    });

    importTx(pairs);

    writeAudit(req, {
      action: "import_env",
      status: "ok",
      tokenName: req.auth.name,
      details: `Imported ${imported} keys, skipped ${skipped} duplicates`,
    });

    res.json({ imported, skipped });
  });

  return router;
}
