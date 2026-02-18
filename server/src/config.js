import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function stripWrappingQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDotEnvFile(filepath) {
  if (!fs.existsSync(filepath)) return {};

  const content = fs.readFileSync(filepath, "utf8");
  const parsed = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const index = line.indexOf("=");
    if (index <= 0) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = stripWrappingQuotes(value);
    parsed[key] = value;
  }

  return parsed;
}

function loadDotEnvVars() {
  const serverEnvPath = path.resolve(__dirname, "../.env");
  const rootEnvPath = path.resolve(__dirname, "../../.env");
  return {
    ...parseDotEnvFile(rootEnvPath),
    ...parseDotEnvFile(serverEnvPath),
  };
}

function parsePositiveInt(name, rawValue, defaultValue) {
  if (rawValue === undefined) return defaultValue;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  if (parsed <= 0) {
    throw new Error(`${name} must be > 0`);
  }
  return parsed;
}

function parseTrustedProxyIps(raw) {
  if (!raw) return ["127.0.0.1", "::1"];
  return raw
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
}

export function loadSettings(env = process.env) {
  const mergedEnv = { ...loadDotEnvVars(), ...env };
  const masterKey = mergedEnv.SECRET_MANAGER_MASTER_KEY;
  const defaultDbPath = path.resolve(__dirname, "../../data/secrets.db");
  if (!masterKey) {
    throw new Error("SECRET_MANAGER_MASTER_KEY is required");
  }

  const rawDbPath = mergedEnv.SECRET_MANAGER_DB_PATH;
  const dbPath = rawDbPath
    ? (path.isAbsolute(rawDbPath)
        ? rawDbPath
        : path.resolve(__dirname, "../../", rawDbPath))
    : defaultDbPath;

  return {
    dbPath,
    masterKey,
    adminToken: mergedEnv.SECRET_MANAGER_ADMIN_TOKEN || null,
    readToken: mergedEnv.SECRET_MANAGER_READ_TOKEN || null,
    rateLimitPerMinute: parsePositiveInt(
      "SECRET_MANAGER_RATE_LIMIT_PER_MINUTE",
      mergedEnv.SECRET_MANAGER_RATE_LIMIT_PER_MINUTE,
      120,
    ),
    publicRateLimitPerMinute: parsePositiveInt(
      "SECRET_MANAGER_PUBLIC_RATE_LIMIT_PER_MINUTE",
      mergedEnv.SECRET_MANAGER_PUBLIC_RATE_LIMIT_PER_MINUTE,
      60,
    ),
    auditLogRetentionDays: parsePositiveInt(
      "SECRET_MANAGER_AUDIT_LOG_RETENTION_DAYS",
      mergedEnv.SECRET_MANAGER_AUDIT_LOG_RETENTION_DAYS,
      90,
    ),
    trustedProxyIps: parseTrustedProxyIps(mergedEnv.SECRET_MANAGER_TRUSTED_PROXY_IPS),
    host: mergedEnv.SECRET_MANAGER_HOST || "0.0.0.0",
    port: parsePositiveInt("SECRET_MANAGER_PORT", mergedEnv.SECRET_MANAGER_PORT, 8000),
  };
}
