import { Router } from "express";
import { scopeAllowsFolder } from "../utils.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CACHE_MS = 15000;
const MAX_TOP = 10;
const MAX_UNREAD = 50;

// range -> bucket size and bucket count. All times are UTC.
const RANGES = {
  "24h": { bucketMs: HOUR_MS, buckets: 24, bucket: "hour", prefixLen: 13 },
  "7d": { bucketMs: DAY_MS, buckets: 7, bucket: "day", prefixLen: 10 },
  "30d": { bucketMs: DAY_MS, buckets: 30, bucket: "day", prefixLen: 10 },
  "90d": { bucketMs: DAY_MS, buckets: 90, bucket: "day", prefixLen: 10 },
};

const ACTIVITY_ACTIONS = [
  "get_secret",
  "export_env",
  "secret_created",
  "secret_updated",
  "secret_edited",
  "secret_deleted",
  "import_env",
  "auth",
  "authz",
  "rate_limit",
];
const READ_ACTIONS = new Set(["get_secret", "export_env"]);
const WRITE_ACTIONS = new Set([
  "secret_created",
  "secret_updated",
  "secret_edited",
  "secret_deleted",
  "import_env",
]);

// Anchored detail parsers. Folder names allow spaces but never `=` or `|`.
const EDIT_TO_REGEX =
  / to=([^|]+)\|([A-Za-z_][A-Za-z0-9_]*) value_changed=(true|false)$/;
const RENAME_REGEX = /^(.+) -> (.+) \((\d+) secrets\)$/;

// Binary (code-point) order, never localeCompare: identical in every locale
// and in the Go port.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const floorTo = (ms, size) => Math.floor(ms / size) * size;
const ceilTo = (ms, size) => Math.ceil(ms / size) * size;
const iso = (ms) => new Date(ms).toISOString();
const pairKey = (folder, key) => `${folder}\u0000${key}`;

function parseRange(raw) {
  if (raw === undefined) return "7d";
  if (typeof raw === "string" && Object.hasOwn(RANGES, raw)) return raw;
  return null;
}

/**
 * Keys of secrets the audit evidence says were read in the window. Rules:
 * a. ok get_secret of that key (legacy NULL details match by key alone; new rows
 *    must carry `folder=<F>` equal to the secret's folder);
 * b. ok export_env listing the folder (legacy NULL details cover every folder);
 * c. ok secret_edited whose `to=<F>|<K>` is the secret (value-only PATCH counts;
 *    bulk overwrite secret_updated does not);
 * d. ok folder_renamed into the secret's folder (also marks the existing secrets
 *    of a non-empty target folder: conservative).
 */
function buildReadEvidence(rows) {
  const legacyKeys = new Set();
  const folderKeys = new Set();
  const exportedFolders = new Set();
  let exportCoversAll = false;
  const editedTo = new Set();
  const renamedInto = new Set();

  for (const { action, key_name: keyName, details } of rows) {
    if (action === "get_secret") {
      if (keyName === null) continue;
      if (details === null) legacyKeys.add(keyName);
      else if (details.startsWith("folder=")) {
        folderKeys.add(pairKey(details.slice("folder=".length), keyName));
      }
    } else if (action === "export_env") {
      if (details === null) exportCoversAll = true;
      else if (details.startsWith("folders=")) {
        for (const folder of details.slice("folders=".length).split(",")) {
          if (folder) exportedFolders.add(folder);
        }
      }
    } else if (action === "secret_edited") {
      const m = EDIT_TO_REGEX.exec(details || "");
      if (m) editedTo.add(pairKey(m[1], m[2]));
    } else if (action === "folder_renamed") {
      const m = RENAME_REGEX.exec(details || "");
      if (m) renamedInto.add(m[2]);
    }
  }

  return ({ folder, key }) =>
    legacyKeys.has(key) ||
    folderKeys.has(pairKey(folder, key)) ||
    exportCoversAll ||
    exportedFolders.has(folder) ||
    editedTo.has(pairKey(folder, key)) ||
    renamedInto.has(folder);
}

/**
 * Router for GET /api/analytics?range=24h|7d|30d|90d. `now` is an injectable
 * clock returning epoch milliseconds (tests pin it). Writes no audit row of its
 * own: reading analytics must not move the numbers it reports.
 */
export function createAnalyticsRouter(
  db,
  { requireAuth },
  { retentionDays, cacheMs, now = () => Date.now() } = {},
) {
  const router = Router();
  const retention =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays
      : DEFAULT_RETENTION_DAYS;
  const ttlMs =
    Number.isFinite(cacheMs) && cacheMs >= 0 ? cacheMs : DEFAULT_CACHE_MS;
  const adminCache = new Map(); // range -> { builtAt, body }

  router.get("/", requireAuth, (req, res) => {
    const rangeName = parseRange(req.query.range);
    if (!rangeName) return res.status(400).json({ detail: "Invalid range" });
    const { bucketMs, buckets, bucket, prefixLen } = RANGES[rangeName];

    // Admin = write role AND scope "*": the same predicate as GET /api/audit-logs.
    const admin = req.auth.role === "write" && req.auth.scope === "*";

    const nowMs = now();
    if (admin && ttlMs > 0) {
      const hit = adminCache.get(rangeName);
      if (hit && nowMs >= hit.builtAt && nowMs - hit.builtAt < ttlMs) {
        return res.json(hit.body);
      }
    }
    const currentBucket = floorTo(nowMs, bucketMs);
    const windowStart = currentBucket - (buckets - 1) * bucketMs;
    // First whole bucket at or after the prune cutoff (the bucket containing
    // the cutoff may be partly pruned). The prune cutoff is computed from the
    // server's local calendar (index.js setDate), which equals now - R * 24h
    // only on a UTC server; we assume UTC servers (the deployment's TZ), so no
    // DST margin is added.
    const retentionCutoff = ceilTo(nowMs - retention * DAY_MS, bucketMs);
    const effectiveSince = Math.max(windowStart, retentionCutoff);
    const sinceIso = iso(effectiveSince);
    const generatedAt = iso(nowMs);

    const folderCounts = db
      .analyticsSecretFolderCounts()
      .filter((row) => scopeAllowsFolder(req.auth.scope, row.folder))
      .map((row) => ({ folder: row.folder, count: Number(row.count) }))
      .sort((a, b) => b.count - a.count || cmp(a.folder, b.folder));
    const secrets = {
      total: folderCounts.reduce((sum, row) => sum + row.count, 0),
      folders: folderCounts,
    };

    const body = {
      range: rangeName,
      since: sinceIso,
      generated_at: generatedAt,
      retention_days: retention,
      clamped: effectiveSince > windowStart,
      admin,
      secrets,
      tokens: null,
      activity: null,
      top_keys: null,
      top_tokens: null,
      unread: null,
    };

    if (admin) {
      body.tokens = db.analyticsTokenCounts(
        generatedAt,
        iso(nowMs + 7 * DAY_MS),
      );

      const points = new Map();
      const pointList = [];
      for (let t = effectiveSince; t <= currentBucket; t += bucketMs) {
        const point = {
          t: iso(t),
          reads: 0,
          secret_writes: 0,
          auth_failures: 0,
          rate_limited: 0,
        };
        points.set(point.t.slice(0, prefixLen), point);
        pointList.push(point);
      }
      for (const row of db.analyticsActivityCounts(
        sinceIso,
        generatedAt,
        prefixLen,
        ACTIVITY_ACTIONS,
      )) {
        const point = points.get(row.bucket);
        if (!point) continue;
        const n = Number(row.n);
        if (READ_ACTIONS.has(row.action) && row.status === "ok") {
          point.reads += n;
        } else if (WRITE_ACTIONS.has(row.action) && row.status === "ok") {
          point.secret_writes += n;
        } else if (row.action === "auth" || row.action === "authz") {
          point.auth_failures += n;
        } else if (row.action === "rate_limit") {
          point.rate_limited += n;
        }
      }
      body.activity = { bucket, points: pointList };

      body.top_keys = db.analyticsTopKeys(sinceIso, generatedAt, MAX_TOP);
      body.top_tokens = db.analyticsTopTokens(sinceIso, generatedAt, MAX_TOP);

      const wasRead = buildReadEvidence(
        db.analyticsReadEvidence(sinceIso, generatedAt),
      );
      const unread = db
        .analyticsSecretsCreatedBefore(sinceIso)
        .filter((row) => !wasRead(row));
      body.unread = {
        total: unread.length,
        items: unread.slice(0, MAX_UNREAD).map((row) => ({
          folder: row.folder,
          key: row.key,
          created_at: row.created_at,
        })),
      };
    }

    if (admin && ttlMs > 0) adminCache.set(rangeName, { builtAt: nowMs, body });
    res.json(body);
  });

  return router;
}
