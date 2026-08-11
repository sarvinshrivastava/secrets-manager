import { Router } from "express";

export function createAuditRouter(db, { requireAuth, requireWriteAccess }) {
  const router = Router();

  // Audit logs leak every key name, token name, and client IP — restrict to
  // write tokens (admins), never plain read tokens.
  router.get("/", requireAuth, requireWriteAccess, (req, res) => {
    const action =
      typeof req.query.action === "string" && req.query.action.trim()
        ? req.query.action.trim()
        : null;
    const status =
      typeof req.query.status === "string" && req.query.status.trim()
        ? req.query.status.trim()
        : null;
    const key =
      typeof req.query.key === "string" && req.query.key.trim()
        ? req.query.key.trim()
        : null;
    const tokenName =
      typeof req.query.token_name === "string" && req.query.token_name.trim()
        ? req.query.token_name.trim()
        : null;

    const limitRaw =
      typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : 100;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 500)
      : 100;

    const events = db.listAuditLogs({ action, status, key, tokenName, limit });
    res.json({ events });
  });

  return router;
}
