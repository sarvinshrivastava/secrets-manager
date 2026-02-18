import { extractToken, getClientIp } from "../utils.js";

export function createAuthMiddleware(db, crypto, trustedProxyIps) {
  function writeAudit(req, { action, status, keyName = null, tokenName = null, details = null }) {
    db.insertAuditLog({
      tokenName,
      action,
      keyName,
      status,
      ipAddress: getClientIp(req, trustedProxyIps),
      details,
    });
  }

  function unauthorized(res, detail) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ detail });
  }

  function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
      writeAudit(req, { action: "auth", status: "failed", details: "Missing token" });
      return unauthorized(res, "Missing token");
    }

    const tokenRows = db.listTokens();
    for (const row of tokenRows) {
      if (!crypto.verifyToken(token, row.salt, row.token_hash)) continue;

      if (row.revoked_at) {
        writeAudit(req, { action: "auth", status: "failed", details: "Token revoked" });
        return unauthorized(res, "Token has been revoked");
      }

      if (row.expires_at && new Date() > new Date(row.expires_at)) {
        writeAudit(req, { action: "auth", status: "failed", details: "Token expired" });
        return unauthorized(res, "Token has expired");
      }

      req.auth = { name: row.name, role: row.role };
      return next();
    }

    writeAudit(req, { action: "auth", status: "failed", details: "Invalid token" });
    return unauthorized(res, "Invalid token");
  }

  function requireWriteAccess(req, res, next) {
    if (!req.auth || req.auth.role !== "write") {
      writeAudit(req, {
        action: "authz",
        status: "forbidden",
        tokenName: req.auth?.name || null,
        details: "Write access required",
      });
      return res.status(403).json({ detail: "Write token required" });
    }
    return next();
  }

  return { requireAuth, requireWriteAccess, writeAudit };
}
