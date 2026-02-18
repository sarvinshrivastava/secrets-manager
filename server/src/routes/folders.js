import { Router } from "express";

export function createFoldersRouter(db, { requireAuth, requireWriteAccess, writeAudit }) {
  const router = Router();

  router.post("/rename", requireAuth, requireWriteAccess, (req, res) => {
    const { from, to } = req.body || {};

    if (typeof from !== "string" || !from.trim()) {
      return res.status(400).json({ detail: "Source folder is required" });
    }
    if (typeof to !== "string" || !to.trim()) {
      return res.status(400).json({ detail: "Target folder is required" });
    }

    const source = from.trim();
    const target = to.trim();

    if (source === target) {
      return res.status(400).json({ detail: "Source and target folders must differ" });
    }

    const renamed = db.renameFolder(source, target);
    writeAudit(req, {
      action: "folder_renamed",
      status: "ok",
      tokenName: req.auth.name,
      details: `${source} -> ${target} (${renamed} secrets)`,
    });

    return res.json({ status: "ok", from: source, to: target, renamed });
  });

  return router;
}
