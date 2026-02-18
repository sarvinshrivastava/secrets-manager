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
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

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

  // Frontend static files
  const frontendDistPath = path.resolve(__dirname, "../../frontend/dist");
  app.get("/", (_req, res) => res.redirect("/secret-manager/"));
  app.get("/secret-manager", (_req, res) => res.redirect("/secret-manager/"));
  app.use("/secret-manager", express.static(frontendDistPath));
  app.get("/secret-manager/*", (_req, res) => {
    res.sendFile(path.join(frontendDistPath, "index.html"));
  });

  // Global error handler
  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(500).json({ detail: "Internal server error" });
  });

  return app;
}
