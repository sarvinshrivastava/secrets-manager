import { extractToken, getClientIp, parseNamedToken } from "../utils.js";

// Cap the legacy bare-token scan so an invalid bare token can never fan out into
// an unbounded number of 32ms PBKDF2 hashes (event-loop DoS). Named tokens
// (`<name>.<secret>`) never hit this path — they verify exactly one hash.
const MAX_SCAN_TOKENS = 50;

export function createAuthMiddleware(db, crypto, trustedProxyIps) {
  function writeAudit(
    req,
    { action, status, keyName = null, tokenName = null, details = null },
  ) {
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

  // Evaluate a matched token row into an auth result. Only called AFTER the
  // secret hash has been verified, so status details are safe to surface.
  function evaluate(row) {
    if (row.revoked_at) {
      return { ok: false, reason: "revoked", detail: "Token has been revoked" };
    }
    if (row.expires_at && new Date() > new Date(row.expires_at)) {
      return { ok: false, reason: "expired", detail: "Token has expired" };
    }
    return {
      ok: true,
      auth: { name: row.name, role: row.role, scope: row.scope || "*" },
    };
  }

  // Capped scan over ACTIVE tokens only — revoked/expired rows are filtered out
  // BEFORE hashing so no PBKDF2 is spent on them. Used only for bare (legacy /
  // bootstrap) tokens that carry no lookup name.
  async function scanTokens(token) {
    const now = new Date();
    const active = db
      .listTokens()
      .filter(
        (r) =>
          !r.revoked_at && (!r.expires_at || now <= new Date(r.expires_at)),
      )
      .slice(0, MAX_SCAN_TOKENS);

    for (const row of active) {
      if (await crypto.verifyTokenAsync(token, row.salt, row.token_hash)) {
        return {
          ok: true,
          auth: { name: row.name, role: row.role, scope: row.scope || "*" },
        };
      }
    }
    return { ok: false, reason: "invalid", detail: "Invalid token" };
  }

  // Authenticate a raw wire token.
  //   Fast path: `<name>.<secret>` → single getTokenByName + one PBKDF2 (O(1)).
  //   Fallback: bare token → capped scan (back-compat for legacy/bootstrap tokens).
  async function authenticate(token) {
    const named = parseNamedToken(token);
    if (named) {
      const row = db.getTokenByName(named.name);
      if (row) {
        if (
          await crypto.verifyTokenAsync(named.secret, row.salt, row.token_hash)
        ) {
          return evaluate(row);
        }
        // Name resolved but secret is wrong — a forged/stale token. Do NOT fall
        // back to the scan (that would reintroduce the O(tokens) cost).
        return { ok: false, reason: "invalid", detail: "Invalid token" };
      }
      // Name did not resolve — could be a bare token that happens to contain a
      // dot; fall through to the capped scan against the full original token.
    }
    return scanTokens(token);
  }

  async function requireAuth(req, res, next) {
    try {
      const token = extractToken(req);
      if (!token) {
        writeAudit(req, {
          action: "auth",
          status: "failed",
          details: "Missing token",
        });
        return unauthorized(res, "Missing token");
      }

      const result = await authenticate(token);
      if (!result.ok) {
        writeAudit(req, {
          action: "auth",
          status: "failed",
          details:
            result.reason === "revoked"
              ? "Token revoked"
              : result.reason === "expired"
                ? "Token expired"
                : "Invalid token",
        });
        return unauthorized(res, result.detail);
      }

      req.auth = result.auth;
      return next();
    } catch (err) {
      return next(err);
    }
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
