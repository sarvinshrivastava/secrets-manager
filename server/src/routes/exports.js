import { Router } from "express";
import { formatEnvValue } from "../utils.js";

export function createExportsRouter(db, crypto, { requireAuth, requireWriteAccess, writeAudit }) {
  const router = Router();

  router.get("/", requireAuth, requireWriteAccess, (req, res) => {
    const lines = [];

    for (const row of db.listSecretsForExport()) {
      try {
        const value = crypto.decryptValue(row.nonce, row.ciphertext);
        lines.push(`${row.key}=${formatEnvValue(value)}`);
      } catch (error) {
        console.error(`Failed to decrypt key during export: ${row.key}`, error);
        writeAudit(req, {
          action: "export_env",
          status: "error",
          tokenName: req.auth.name,
          details: `Decrypt failed for key ${row.key}`,
        });
        return res.status(500).json({ detail: "Failed to decrypt stored secret" });
      }
    }

    writeAudit(req, { action: "export_env", status: "ok", tokenName: req.auth.name });
    const output = lines.join("\n") + (lines.length ? "\n" : "");
    res.type("text/plain").send(output);
  });

  return router;
}
