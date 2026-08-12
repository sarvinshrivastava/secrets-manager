import { Router } from "express";

export function createAuditRouter(
  db,
  { requireAuth, requireWriteAccess, writeAudit },
) {
  const router = Router();

  // Audit logs leak every key name, token name, and client IP ACROSS ALL scopes
  // — restrict to UNSCOPED admins (`*`). A folder-scoped write token must never
  // read the global audit log.
  router.get("/", requireAuth, requireWriteAccess, (req, res) => {
    if (req.auth.scope !== "*") {
      // Log the denial like requireWriteAccess does — a scoped token probing the
      // global audit log must leave a trace in that same log.
      writeAudit(req, {
        action: "authz",
        status: "forbidden",
        tokenName: req.auth.name,
        details: "Admin token required",
      });
      return res.status(403).json({ detail: "Admin token required" });
    }

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
