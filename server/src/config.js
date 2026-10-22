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
// An age private key (AGE-SECRET-KEY-1…, AGE-SECRET-KEY-PQ-1…) or a plugin
// identity: AGE-PLUGIN-<NAME>-1 followed by a bech32 data run (any case) of
// at least 20 chars (real identities are far longer; shorter runs match
// version strings and path segments such as "age-plugin-x-1qpzry9x8gf")
// (the name may contain hyphens, e.g. FIDO2-HMAC). Binary paths such as
// /opt/age-plugin-yubikey-1.2/bin do not match.
const PRIVATE_KEY_RES = [
  /AGE-SECRET-KEY-/i,
  /AGE-PLUGIN-[A-Z0-9._+-]+-1[02-9AC-HJ-NP-Z]{20,}/i,
];
// Upper bounds keep a typo from turning into a huge loop or array.
const MAX_KEEP_DAYS = 3650;
// GitHub allows 1000 assets per release; daily + monthly + the current slot
// must fit, with room for a few broken or foreign assets.
const MAX_REMOTE_ASSETS = 990;
const MAX_REMOTE_KEEP_DAILY = MAX_REMOTE_ASSETS;
const MAX_REMOTE_KEEP_MONTHLY = MAX_REMOTE_ASSETS;
// Directories the backup dir must stay out of: the served frontend, the code,
// and the live data mount (plus the configured DB's own directory).
const FORBIDDEN_BACKUP_ROOTS = ["../../frontend", "../../server", "../../data"].map(
  (p) => path.resolve(__dirname, p),
);

function resolveDbPath(rawDbPath) {
  if (!rawDbPath) return path.resolve(__dirname, "../../data/secrets.db");
  return path.isAbsolute(rawDbPath)
    ? rawDbPath
    : path.resolve(__dirname, "../../", rawDbPath);
}

// Non-throwing twin of parsePositiveInt: null when set but invalid.
function positiveIntOrNull(rawValue, defaultValue, max) {
  if (rawValue === undefined || rawValue === "") return defaultValue;
  if (!/^\d+$/.test(String(rawValue).trim())) return null;
  const parsed = Number.parseInt(rawValue, 10);
  return parsed > 0 && parsed <= max ? parsed : null;
}

// Lexical containment (symlinks are not followed: the dir is operator config).
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
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
    ? path.resolve(rawDir)
    : path.resolve(__dirname, "../../", rawDir);
  // Inside (or a parent of) frontend/ (served by express.static), server/,
  // data/ or the DB's directory: refuse the whole feature rather than write
  // plaintext copies there.
  const forbidden = [
    ...FORBIDDEN_BACKUP_ROOTS,
    path.dirname(resolveDbPath(env.SECRET_MANAGER_DB_PATH)),
  ];
  if (forbidden.some((root) => isInside(dir, root) || isInside(root, dir))) {
    return { enabled: false, error: "config_invalid" };
  }

  // An invalid local key falls back to its default; every run then reports
  // config_invalid (paged when a push URL is configured).
  const parsedTime = parseUtcTime(
    env.SECRET_MANAGER_BACKUP_UTC_TIME || DEFAULT_BACKUP_TIME,
  );
  const parsedKeepDays = positiveIntOrNull(
    env.SECRET_MANAGER_BACKUP_KEEP_DAYS,
    DEFAULT_KEEP_DAYS,
    MAX_KEEP_DAYS,
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
  const leaked = Object.values(env).some((v) =>
    PRIVATE_KEY_RES.some((re) => re.test(String(v ?? ""))),
  );
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
    MAX_REMOTE_KEEP_DAILY,
  );
  const keepMonthly = positiveIntOrNull(
    env.SECRET_MANAGER_BACKUP_REMOTE_KEEP_MONTHLY,
    DEFAULT_REMOTE_KEEP_MONTHLY,
    MAX_REMOTE_KEEP_MONTHLY,
  );
  const tooMany =
    keepDaily !== null &&
    keepMonthly !== null &&
    keepDaily + keepMonthly + 1 > MAX_REMOTE_ASSETS;
  if (
    tooMany ||
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
