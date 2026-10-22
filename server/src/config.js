import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Encrypter } from "age-encryption";
import { parseUtcTime } from "./backup/schedule.js";

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

// ── Backup settings ───────────────────────────────────────────────────────
// Separate from the throwing parsers above on purpose: a typo in a backup key
// must never stop the vault from booting (every CI depends on it). Problems
// are reported as reason codes only (never the offending value), and the
// runner turns them into a Kuma page.

const DEFAULT_BACKUP_TIME = "22:30";
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_REMOTE_KEEP_DAILY = 30;
const DEFAULT_REMOTE_KEEP_MONTHLY = 12;
const REPO_RE = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const PRIVATE_KEY_MARKERS = ["AGE-SECRET-KEY-", "AGE-PLUGIN-"];

// Non-throwing twin of parsePositiveInt: null when set but invalid.
function positiveIntOrNull(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === "") return defaultValue;
  if (!/^\d+$/.test(String(rawValue).trim())) return null;
  const parsed = Number.parseInt(rawValue, 10);
  return parsed > 0 ? parsed : null;
}

// Only native X25519 (age1…) and hybrid post-quantum (age1pq1…) recipients.
// Tag recipients (age1tag1…, age1tagpq1…) need a plugin or hardware key to
// decrypt, so they are refused.
function parseRecipients(raw) {
  const list = String(raw ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  for (const r of list) {
    if (!r.startsWith("age1") || r.startsWith("age1tag")) return null;
    try {
      new Encrypter().addRecipient(r); // synchronous bech32 decode
    } catch {
      return null;
    }
  }
  return list;
}

function parseHttpsUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseBackupSettings(env = {}) {
  const rawDir = env.SECRET_MANAGER_BACKUP_DIR;
  if (!rawDir) return { enabled: false };

  const dir = path.isAbsolute(rawDir)
    ? rawDir
    : path.resolve(__dirname, "../../", rawDir);

  // An invalid local key falls back to its default and is reported once.
  const parsedTime = parseUtcTime(
    env.SECRET_MANAGER_BACKUP_UTC_TIME || DEFAULT_BACKUP_TIME,
  );
  const parsedKeepDays = positiveIntOrNull(
    env.SECRET_MANAGER_BACKUP_KEEP_DAYS,
    DEFAULT_KEEP_DAYS,
  );
  const localValid = parsedTime !== null && parsedKeepDays !== null;
  const time = parsedTime ?? parseUtcTime(DEFAULT_BACKUP_TIME);
  const keepDays = parsedKeepDays ?? DEFAULT_KEEP_DAYS;
  const localErrors = localValid ? [] : ["config_invalid"];

  const result = {
    enabled: true,
    dir,
    time,
    keepDays,
    offsite: null,
    pushUrl: null,
    localErrors,
    offsiteErrors: [],
    offsiteDisabledReason: null,
  };

  const rawRecipient = env.SECRET_MANAGER_BACKUP_AGE_RECIPIENT;
  const rawRepo = env.SECRET_MANAGER_BACKUP_GITHUB_REPO;
  const token = env.SECRET_MANAGER_BACKUP_GITHUB_TOKEN;
  const rawPushUrl = env.SECRET_MANAGER_BACKUP_PUSH_URL;
  const requested = Boolean(rawRecipient || rawRepo || token || rawPushUrl);

  // Dev boxes and tests never upload and never page the production monitor.
  const production =
    env.NODE_ENV === "production" ||
    env.SECRET_MANAGER_BACKUP_ALLOW_NONPROD === "1";
  if (!production) {
    if (requested) result.offsiteDisabledReason = "nonprod";
    return result;
  }

  result.pushUrl = parseHttpsUrl(rawPushUrl);

  // The age private key must never be on the VPS: scan every env value.
  const leaked = Object.values(env).some((v) => {
    const upper = String(v ?? "").toUpperCase();
    return PRIVATE_KEY_MARKERS.some((m) => upper.includes(m));
  });
  if (leaked) {
    result.offsiteErrors.push("private_key_on_vps");
    return result;
  }

  if (!requested) return result;

  const recipients = parseRecipients(rawRecipient);
  const repoMatch = REPO_RE.exec(rawRepo ?? "");
  const keepDaily = positiveIntOrNull(
    env.SECRET_MANAGER_BACKUP_REMOTE_KEEP_DAILY,
    DEFAULT_REMOTE_KEEP_DAILY,
  );
  const keepMonthly = positiveIntOrNull(
    env.SECRET_MANAGER_BACKUP_REMOTE_KEEP_MONTHLY,
    DEFAULT_REMOTE_KEEP_MONTHLY,
  );
  if (
    !recipients ||
    !repoMatch ||
    !token ||
    !result.pushUrl ||
    keepDaily === null ||
    keepMonthly === null
  ) {
    result.offsiteErrors.push("config_invalid");
    return result;
  }

  result.offsite = {
    recipients,
    owner: repoMatch[1],
    repo: repoMatch[2],
    tag: env.SECRET_MANAGER_BACKUP_GITHUB_RELEASE_TAG || "daily",
    token,
    keepDaily,
    keepMonthly,
  };
  return result;
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
    backup: parseBackupSettings(mergedEnv),
  };
}
