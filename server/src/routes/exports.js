import { Router } from "express";
import { formatEnvValue, scopeAllowsFolder } from "../utils.js";

export function createExportsRouter(
  db,
  crypto,
  { requireAuth, requireWriteAccess, writeAudit },
) {
  const router = Router();

  // GET /api/exports — dotenv dump. Grouped by folder with a `# folder=<name>`
  // header per group so two folders sharing a key never collide, and a re-import
  // reconstructs the exact folder layout.
  router.get("/", requireAuth, requireWriteAccess, (req, res) => {
    const byFolder = new Map();

    for (const row of db.listSecretsForExport()) {
      if (!scopeAllowsFolder(req.auth.scope, row.folder)) continue;
      let value;
      try {
        value = crypto.decryptValue(row.nonce, row.ciphertext);
      } catch (error) {
        console.error(`Failed to decrypt key during export: ${row.key}`, error);
        writeAudit(req, {
          action: "export_env",
          status: "error",
          tokenName: req.auth.name,
          details: `Decrypt failed for key ${row.key}`,
        });
        return res
          .status(500)
          .json({ detail: "Failed to decrypt stored secret" });
      }
      if (!byFolder.has(row.folder)) byFolder.set(row.folder, []);
      byFolder.get(row.folder).push(`${row.key}=${formatEnvValue(value)}`);
    }

    const folders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));
    const blocks = folders.map(
      (folder) => `# folder=${folder}\n${byFolder.get(folder).join("\n")}`,
    );
    const output = blocks.join("\n\n") + (blocks.length ? "\n" : "");

    writeAudit(req, {
      action: "export_env",
      status: "ok",
      tokenName: req.auth.name,
    });
    res.type("text/plain").send(output);
  });

  return router;
}
