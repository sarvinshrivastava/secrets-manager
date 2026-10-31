import { getClientIp } from "../utils.js";

export function createSecurityMiddleware(db, rateLimiter, trustedProxyIps) {
  function securityHeaders(req, res, next) {
    // API responses can carry secret material: no cache may store them.
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains",
    );
    next();
  }

  function globalRateLimit(req, res, next) {
    if (!req.path.startsWith("/api/")) return next();

    const ip = getClientIp(req, trustedProxyIps);
    const { allowed, retryAfter } = rateLimiter.allow(ip);
    if (!allowed) {
      db.insertAuditLog({
        tokenName: null,
        action: "rate_limit",
        keyName: null,
        status: "blocked",
        ipAddress: ip,
        details: "Per-IP limit exceeded",
      });
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ detail: "Rate limit exceeded" });
    }
    return next();
  }

  return { securityHeaders, globalRateLimit };
}
