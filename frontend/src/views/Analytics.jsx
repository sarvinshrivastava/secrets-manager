import { useEffect, useId, useState } from "react";
import { MdRefresh } from "react-icons/md";
import { getAnalytics } from "../api.js";

const RANGES = ["24h", "7d", "30d", "90d"];
const DEFAULT_RANGE = "7d";

const DEFS = {
  reads:
    "Reads: successful get_secret and export_env events. Listing keys is not a read.",
  secret_writes:
    "Secret writes: successful secret_created, secret_updated, secret_edited, secret_deleted and import_env events (one import_env event per import, not per key).",
  auth_failures:
    "Auth failures: audit rows with action auth or authz, any status. Folder-scope denials are not audited, so they are not counted.",
  rate_limited: "Rate limited: audit rows with action rate_limit.",
};

const SERIES = [
  { id: "reads", label: "Reads", bar: "bg-accent", def: DEFS.reads },
  {
    id: "secret_writes",
    label: "Secret writes",
    bar: "bg-warn",
    def: DEFS.secret_writes,
  },
  {
    id: "auth_failures",
    label: "Auth failures",
    bar: "bg-danger",
    def: DEFS.auth_failures,
  },
  {
    id: "rate_limited",
    label: "Rate limited",
    bar: "bg-faint",
    def: DEFS.rate_limited,
  },
];

// Tile and panel caveats, shown in the visible Definitions block.
const HINTS = {
  secrets: "Secrets: secrets in the folders this token can access.",
  folders: "Folders: folders holding at least one secret.",
  active_tokens: "Active tokens: not revoked and not expired.",
  expiring_7d: "Expiring in 7d: active tokens that expire within the next 7 days.",
  expired: "Expired: not revoked, past their expiry.",
  revoked: "Revoked (all time): every revoked token, regardless of the selected range.",
  per_folder: "Secrets per folder: folders with at least one secret, largest first.",
  activity: "Activity: event counts per bucket, UTC.",
  top_keys:
    "Top keys: successful get_secret reads grouped by key name alone; the same key in different folders is merged.",
  top_tokens: "Top tokens: tokens by number of audit events in the window.",
  unread:
    "Not read in window: secrets created before the window with no read in it. A hint for review, never a delete list.",
};

const UNREAD_FOOTNOTE =
  "Reads through .env export count by folder. Secrets renamed or moved in the window count as read. Reads logged before this version are matched by key name only.";
const FAILURE_FOOTNOTE =
  "Auth failures and rate limited count logged audit rows, not attempts: repeated identical failures may be logged once per minute.";

// Bucket timestamps are ISO UTC ("2026-10-31T10:00:00.000Z"); slice, never
// convert to local time.
function bucketLabel(t, bucket) {
  const s = String(t || "");
  return bucket === "hour"
    ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`
    : `${s.slice(0, 10)} UTC`;
}

function utcStamp(value) {
  const s = String(value || "");
  if (!s) return "—";
  return `${s.replace("T", " ").slice(0, 16)} UTC`;
}

function Panel({ title, children }) {
  return (
    <section className="border border-line bg-surface p-4">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <p className="py-4 font-mono text-sm text-muted">{children}</p>;
}

function Tile({ label, value }) {
  return (
    <div className="border border-line bg-surface px-3 py-2">
      <div className="font-mono text-xs text-muted">{label}</div>
      <div className="font-mono text-2xl font-semibold text-ink">{value}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading analytics"
      className="animate-pulse space-y-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 border border-line bg-surface" />
        ))}
      </div>
      <div className="h-40 border border-line bg-surface" />
      <div className="h-40 border border-line bg-surface" />
    </div>
  );
}

function FolderBars({ folders }) {
  const max = Math.max(1, ...folders.map((f) => f.count));
  return (
    <ul className="space-y-1.5">
      {folders.map((f) => (
        <li
          key={f.folder}
          className="flex items-center gap-2 font-mono text-xs"
        >
          <span className="w-32 shrink-0 truncate text-ink" title={f.folder}>
            {f.folder}
          </span>
          <span className="h-3 min-w-0 flex-1 bg-accent-soft">
            <span
              className="block h-3 bg-accent"
              style={{ width: `${(f.count / max) * 100}%` }}
              role="img"
              aria-label={`${f.folder}: ${f.count} secrets`}
            />
          </span>
          <span className="w-8 shrink-0 text-right text-muted">{f.count}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivityChart({ activity }) {
  const summaryId = useId();
  const { bucket, points } = activity;
  const totals = SERIES.map((s) => ({
    ...s,
    total: points.reduce((sum, p) => sum + (p[s.id] || 0), 0),
  }));
  const grand = totals.reduce((sum, s) => sum + s.total, 0);
  if (points.length === 0 || grand === 0) {
    return <Empty>No activity in this window.</Empty>;
  }
  const max = Math.max(
    1,
    ...points.map((p) => SERIES.reduce((sum, s) => sum + (p[s.id] || 0), 0)),
  );
  const first = bucketLabel(points[0].t, bucket);
  const last = bucketLabel(points[points.length - 1].t, bucket);

  return (
    <div>
      <p id={summaryId} className="mb-2 font-mono text-xs text-muted">
        {totals.map((s) => `${s.total} ${s.label.toLowerCase()}`).join(" · ")}
        {" · per "}
        {bucket}, {first} to {last}
      </p>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        {SERIES.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-1 font-mono text-xs text-muted"
          >
            <span className={`inline-block h-2.5 w-2.5 ${s.bar}`} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="mb-0.5 text-right font-mono text-xs text-muted">
        peak {max} per {bucket}
      </div>
      <div
        className="flex h-32 items-end gap-px border-b border-t border-dashed border-line"
        role="img"
        aria-labelledby={summaryId}
      >
        {points.map((p) => {
          const label = `${bucketLabel(p.t, bucket)}: ${SERIES.map(
            (s) => `${p[s.id] || 0} ${s.label.toLowerCase()}`,
          ).join(", ")}`;
          return (
            <div
              key={p.t}
              title={label}
              className="flex h-full min-w-0 max-w-8 flex-1 flex-col-reverse"
            >
              {SERIES.map((s) =>
                p[s.id] ? (
                  <span
                    key={s.id}
                    title={`${s.label}: ${p[s.id]}`}
                    className={`block min-h-[2px] w-full ${s.bar}`}
                    style={{ height: `${(p[s.id] / max) * 100}%` }}
                  />
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-muted">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <details className="mt-3 font-mono text-xs">
        <summary className="cursor-pointer text-muted">
          Show as table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto border border-line">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th className="px-2 py-1 font-normal">
                  {bucket === "hour" ? "Hour (UTC)" : "Day (UTC)"}
                </th>
                {SERIES.map((s) => (
                  <th key={s.id} className="px-2 py-1 text-right font-normal">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-ink">
              {points.map((p) => (
                <tr key={p.t}>
                  <td className="px-2 py-1">{bucketLabel(p.t, bucket)}</td>
                  {SERIES.map((s) => (
                    <td key={s.id} className="px-2 py-1 text-right">
                      {p[s.id] || 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function RankList({ items, nameKey, countKey, empty, unit }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ol className="divide-y divide-line">
      {items.map((item) => (
        <li
          key={item[nameKey]}
          className="flex items-baseline gap-2 py-1 font-mono text-xs"
        >
          <span
            className="min-w-0 flex-1 truncate text-ink"
            title={item[nameKey]}
          >
            {item[nameKey]}
          </span>
          <span className="shrink-0 text-muted">
            {item[countKey]} {unit}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Unread({ unread }) {
  const { total, items } = unread;
  return (
    <>
      {items.length === 0 ? (
        <Empty>No unread secrets found.</Empty>
      ) : (
        <>
          <div className="max-h-80 overflow-auto border border-line">
            <table className="w-full text-left font-mono text-xs">
              <thead className="sticky top-0 bg-surface text-muted">
                <tr>
                  <th className="px-2 py-1 font-normal">Folder</th>
                  <th className="px-2 py-1 font-normal">Key</th>
                  <th className="px-2 py-1 font-normal">Created (UTC)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink">
                {items.map((item) => (
                  <tr key={`${item.folder} ${item.key}`}>
                    <td
                      className="max-w-[10rem] truncate px-2 py-1"
                      title={item.folder}
                    >
                      {item.folder}
                    </td>
                    <td
                      className="max-w-[16rem] truncate px-2 py-1"
                      title={item.key}
                    >
                      {item.key}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-muted">
                      {utcStamp(item.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > items.length && (
            <p className="mt-1 font-mono text-xs text-muted">
              Showing {items.length} of {total}.
            </p>
          )}
        </>
      )}
      <p className="mt-2 font-mono text-xs text-faint">{UNREAD_FOOTNOTE}</p>
    </>
  );
}

function Dashboard({ data }) {
  const folders = data.secrets?.folders || [];
  const tokens = data.tokens;
  const admin = Boolean(data.admin);

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-muted">
        Window since {utcStamp(data.since)} · generated{" "}
        {utcStamp(data.generated_at)} · all times UTC
      </p>

      {data.clamped && (
        <p
          role="note"
          className="border border-warn px-3 py-2 font-mono text-xs text-warn"
        >
          Window limited by audit retention ({data.retention_days} days)
        </p>
      )}

      {!admin && (
        <p
          role="note"
          className="border border-line-strong px-3 py-2 font-mono text-xs text-muted"
        >
          Token, activity and key-usage panels are only shown for an unscoped
          write token. Showing secrets you can access.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="Secrets"
          value={data.secrets?.total ?? 0}
        />
        <Tile label="Folders" value={folders.length} />
        {admin && tokens && (
          <>
            <Tile label="Active tokens" value={tokens.active} />
            <Tile label="Expiring in 7d" value={tokens.expiring_7d} />
            <Tile label="Expired" value={tokens.expired} />
            <Tile label="Revoked (all time)" value={tokens.revoked_all_time} />
          </>
        )}
      </div>

      <Panel title="Secrets per folder">
        {folders.length === 0 ? (
          <Empty>No secrets yet.</Empty>
        ) : (
          <FolderBars folders={folders} />
        )}
      </Panel>

      {admin && data.activity && (
        <Panel title="Activity">
          <ActivityChart activity={data.activity} />
          <p className="mt-2 font-mono text-xs text-faint">
            {FAILURE_FOOTNOTE}
          </p>
        </Panel>
      )}

      {admin && (
        <div className="grid gap-4 md:grid-cols-2">
          {data.top_keys && (
            <Panel title="Top keys (by key name)">
              <RankList
                items={data.top_keys}
                nameKey="key"
                countKey="reads"
                unit="reads"
                empty="No reads in this window."
              />
            </Panel>
          )}
          {data.top_tokens && (
            <Panel title="Top tokens">
              <RankList
                items={data.top_tokens}
                nameKey="name"
                countKey="events"
                unit="events"
                empty="No token activity in this window."
              />
            </Panel>
          )}
        </div>
      )}

      {admin && data.unread && (
        <Panel title="Not read in window">
          <Unread unread={data.unread} />
        </Panel>
      )}

      <details open className="font-mono text-xs">
        <summary className="cursor-pointer text-muted">Definitions</summary>
        <ul className="mt-2 space-y-1 text-muted">
          <li>{HINTS.secrets}</li>
          <li>{HINTS.folders}</li>
          <li>{HINTS.per_folder}</li>
          {admin && tokens && (
            <>
              <li>{HINTS.active_tokens}</li>
              <li>{HINTS.expiring_7d}</li>
              <li>{HINTS.expired}</li>
              <li>{HINTS.revoked}</li>
            </>
          )}
          {admin && data.activity && <li>{HINTS.activity}</li>}
          {SERIES.map((s) => (
            <li key={s.id}>{s.def}</li>
          ))}
          {admin && data.top_keys && <li>{HINTS.top_keys}</li>}
          {admin && data.top_tokens && <li>{HINTS.top_tokens}</li>}
          {admin && data.unread && <li>{HINTS.unread}</li>}
        </ul>
      </details>
    </div>
  );
}

export default function Analytics({ token }) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // A later range/retry/unmount flips this, so a slow earlier response can
    // never overwrite a newer one.
    let stale = false;
    setLoading(true);
    setError("");
    setData(null);
    getAnalytics(token, range)
      .then((payload) => {
        if (!stale) setData(payload);
      })
      .catch((err) => {
        if (!stale) setError(err?.message || "Request failed");
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [token, range, reloadKey]);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Analytics</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Time range"
          className="flex border border-line-strong"
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`border-r border-line-strong px-3 py-1.5 font-mono text-sm transition-colors last:border-r-0 ${
                range === r
                  ? "bg-accent text-surface"
                  : "bg-surface text-muted hover:text-ink"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="sm-btn ml-auto px-2 py-1.5"
          title="Refresh"
          aria-label="Refresh analytics"
        >
          <MdRefresh size={16} />
        </button>
      </div>

      {loading && <Skeleton />}

      {!loading && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border border-danger px-3 py-3 font-mono text-sm text-danger"
        >
          <span>Failed to load analytics: {error}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="sm-btn"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && <Dashboard data={data} />}
    </div>
  );
}
