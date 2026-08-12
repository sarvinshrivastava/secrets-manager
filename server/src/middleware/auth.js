import nodeCrypto from "node:crypto";
import { extractToken, getClientIp, parseNamedToken } from "../utils.js";

// Cap the legacy bare-token scan so an invalid bare token can never fan out into
// an unbounded number of 32ms PBKDF2 hashes (event-loop DoS). Named tokens
// (`<name>.<secret>`) never hit this path — they verify exactly one hash.
const MAX_SCAN_TOKENS = 50;

// Dummy PBKDF2 material. A named token whose NAME does not resolve spends ONE
// hash against these throwaway values so its latency matches a name-that-resolves
// -but-wrong-secret — closing the token-name enumeration timing oracle.
const DUMMY_SALT = nodeCrypto.randomBytes(16);
const DUMMY_HASH = nodeCrypto.randomBytes(32);

// Audit-detail label for a failed auth, keyed by failure reason.
const AUTH_FAIL_DETAIL = { revoked: "Token revoked", expired: "Token expired" };

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
  //   Named path: `<name>.<secret>` → single getTokenByName + exactly one PBKDF2
  //     (O(1)). A missing name spends one DUMMY hash so timing is constant; a
  //     wrong secret spends the real hash. Neither ever falls back to the scan —
  //     that would reintroduce O(tokens) cost AND a name-existence timing oracle.
  //   Scan path: reserved strictly for tokens with NO `.` (legacy/bootstrap).
  //
  // NOTE: raw/bootstrap tokens MUST NOT contain a `.` — a bare token whose prefix
  // matches the token-name pattern (`<name>.<secret>`) is now treated as NAMED
  // and will not authenticate via the scan.
  async function authenticate(token) {
    const named = parseNamedToken(token);
    if (named) {
      const row = db.getTokenByName(named.name);
      if (
        row &&
        (await crypto.verifyTokenAsync(named.secret, row.salt, row.token_hash))
      ) {
        return evaluate(row);
      }
      // Name unresolved OR secret wrong. If the name never resolved we did NOT
      // spend a real hash above (short-circuit), so burn one dummy PBKDF2 to keep
      // the response time indistinguishable from the wrong-secret case.
      if (!row) {
        await crypto.verifyTokenAsync(named.secret, DUMMY_SALT, DUMMY_HASH);
      }
      return { ok: false, reason: "invalid", detail: "Invalid token" };
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
          details: AUTH_FAIL_DETAIL[result.reason] ?? "Invalid token",
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
