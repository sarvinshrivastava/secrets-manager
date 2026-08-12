import { Router } from "express";
import express from "express";
import {
  requireEnvKey,
  parseEnvValue,
  isValidFolderName,
  scopeAllowsFolder,
} from "../utils.js";

// Matches an in-band `# folder=<name>` header line that switches the active
// folder for subsequent key=value lines (produced by GET /api/exports).
const FOLDER_HEADER_REGEX = /^#\s*folder\s*=\s*(.+)$/i;

export function createImportRouter(
  db,
  crypto,
  { requireAuth, requireWriteAccess, writeAudit },
) {
  const router = Router();

  router.use(express.text({ type: "text/plain", limit: "512kb" }));

  router.post("/", requireAuth, requireWriteAccess, (req, res) => {
    if (typeof req.body !== "string") {
      return res.status(400).json({ detail: "Expected text/plain body" });
    }

    // Default folder: ?folder= query (validated), else Root. `# folder=` headers
    // in the body override this for the lines that follow them.
    let defaultFolder = "Root";
    if (typeof req.query.folder === "string" && req.query.folder.trim()) {
      defaultFolder = req.query.folder.trim();
      if (!isValidFolderName(defaultFolder)) {
        return res.status(400).json({ detail: "Invalid folder in query" });
      }
    }

    let imported = 0;
    let skipped = 0;
    const lines = req.body.split(/\r?\n/);

    const pairs = [];
    let activeFolder = defaultFolder;

    for (let i = 0; i < lines.length; i += 1) {
      let stripped = lines[i].trim();
      const lineNumber = i + 1;

      if (!stripped) continue;

      if (stripped.startsWith("#")) {
        const headerMatch = stripped.match(FOLDER_HEADER_REGEX);
        if (headerMatch) {
          const folder = headerMatch[1].trim();
          if (!isValidFolderName(folder)) {
            return res
              .status(400)
              .json({ detail: `Invalid folder header at line ${lineNumber}` });
          }
          activeFolder = folder;
        }
        continue; // plain comment or a consumed folder header
      }

      if (stripped.startsWith("export ")) {
        stripped = stripped.slice(7).trim();
      }

      const equalIndex = stripped.indexOf("=");
      if (equalIndex < 0) {
        return res
          .status(400)
          .json({ detail: `Invalid .env line at ${lineNumber}: missing '='` });
      }

      const key = stripped.slice(0, equalIndex).trim();
      const rawValue = stripped.slice(equalIndex + 1);

      if (!requireEnvKey(key)) {
        return res
          .status(400)
          .json({ detail: `Invalid key at line ${lineNumber}: ${key}` });
      }

      pairs.push({ key, value: parseEnvValue(rawValue), folder: activeFolder });
    }

    // Enforce scope for every target folder before writing anything.
    const targetFolders = new Set(pairs.map((p) => p.folder));
    for (const folder of targetFolders) {
      if (!scopeAllowsFolder(req.auth.scope, folder)) {
        return res
          .status(403)
          .json({ detail: `Token not scoped for folder '${folder}'` });
      }
    }

    // Wrap in transaction — all-or-nothing.
    const importTx = db.db.transaction((entries) => {
      for (const { key, value, folder } of entries) {
        const encrypted = crypto.encryptValue(value);
        const created = db.createSecret(
          folder,
          key,
          encrypted.nonce,
          encrypted.ciphertext,
        );
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
