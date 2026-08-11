import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { createAuthMiddleware } from "./middleware/auth.js";
import { createSecurityMiddleware } from "./middleware/security.js";
import { createAuditRouter } from "./routes/audit.js";
import { createExportsRouter } from "./routes/exports.js";
import { createFoldersRouter } from "./routes/folders.js";
import { createImportRouter } from "./routes/import.js";
import { createSecretsRouter } from "./routes/secrets.js";
import { createTokensRouter } from "./routes/tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(settings, db, crypto, rateLimiter) {
  const { requireAuth, requireWriteAccess, writeAudit } = createAuthMiddleware(
    db,
    crypto,
    settings.trustedProxyIps,
  );
  const { securityHeaders, globalRateLimit } = createSecurityMiddleware(
    db,
    rateLimiter,
    settings.trustedProxyIps,
  );

  const authHandlers = { requireAuth, requireWriteAccess, writeAudit };

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  // 256kb: a single secret value caps at 32kb, but POST /api/secrets/bulk carries
  // many at once. Still a sane cap that bounds request-body memory / DoS.
  app.use(express.json({ limit: "256kb" }));

  app.use(securityHeaders);
  app.use(globalRateLimit);

  // Health check (no auth)
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Auth identity
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ token_name: req.auth.name, role: req.auth.role });
  });

  // Secrets (list + create + folder-scoped get/delete)
  app.use(
    "/api/secrets",
    createSecretsRouter(db, crypto, authHandlers, {
      publicRateLimitPerMinute: settings.publicRateLimitPerMinute,
      trustedProxyIps: settings.trustedProxyIps,
    }),
  );

  // Tokens management
  app.use("/api/tokens", createTokensRouter(db, crypto, authHandlers));

  // Folders
  app.use("/api/folders", createFoldersRouter(db, authHandlers));

  // Exports (write-only bulk export)
  app.use("/api/exports", createExportsRouter(db, crypto, authHandlers));

  // Import (write-only bulk import, moved out of /api/secrets/* prefix)
  app.use("/api/import", createImportRouter(db, crypto, authHandlers));

  // Audit logs
  app.use("/api/audit-logs", createAuditRouter(db, authHandlers));

  // Terminal JSON 404 for unknown /api/* routes — must sit BEFORE the SPA
  // fallback so an unknown API path returns JSON, not index.html.
  app.use("/api", (_req, res) => res.status(404).json({ detail: "Not found" }));

  // Frontend static files
  const frontendDistPath = path.resolve(__dirname, "../../frontend/dist");
  app.get("/secret-manager", (_req, res) => res.redirect("/secret-manager/"));
  app.use("/secret-manager", express.static(frontendDistPath));
  app.get("/secret-manager/*", (_req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
  });

  // Global error handler.
  // - Honor err.status/err.statusCode (malformed JSON -> 400, oversized body -> 413)
  //   instead of blanket 500.
  // - NEVER log err itself: body-parser attaches err.body = the raw request body,
  //   which for /api/secrets and /api/import is PLAINTEXT SECRETS. Log only a
  //   redacted line (message + status).
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    console.error(`Request error: status=${status} message=${err.message}`);
    if (res.headersSent) return;
    const detail =
      status === 500 ? "Internal server error" : err.message || "Error";
    res.status(status).json({ detail });
  });

  return app;
}
