import { useEffect, useMemo, useState } from "react";
import { MdRefresh } from "react-icons/md";
import { toast } from "react-hot-toast";
import { listAuditLogs } from "../api.js";

const READ_ACTIONS = new Set(["get_secret", "list_keys", "export_env"]);
const DENIED_STATUS = new Set(["denied", "blocked", "error", "forbidden"]);
const DENIED_ACTIONS = new Set(["rate_limit", "auth", "authz"]);

// Classify each event into one verb category. Color is reserved for state.
function classify(event) {
  const status = String(event.status || "").toLowerCase();
  if (DENIED_STATUS.has(status) || DENIED_ACTIONS.has(event.action))
    return "denied";
  if (READ_ACTIONS.has(event.action)) return "read";
  return "write";
}

const CATEGORY_STYLE = {
  read: "text-accent",
  write: "text-warn",
  denied: "text-danger",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "read", label: "Read" },
  { id: "write", label: "Write" },
  { id: "denied", label: "Denied" },
];

function formatTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function AuditList({ token }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");

  async function refresh() {
    setLoading(true);
    try {
      const payload = await listAuditLogs(token, { limit: 200 });
      setEvents(payload.events || []);
    } catch (error) {
      if (error.message !== "Unauthorized") {
        toast.error(`Failed to load audit log: ${error.message}`);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const decorated = useMemo(
    () => events.map((event) => ({ ...event, category: classify(event) })),
    [events],
  );

  const visible = useMemo(
    () =>
      filter === "all"
        ? decorated
        : decorated.filter((e) => e.category === filter),
    [decorated, filter],
  );

  const counts = useMemo(() => {
    const acc = { all: decorated.length, read: 0, write: 0, denied: 0 };
    decorated.forEach((e) => {
      acc[e.category] += 1;
    });
    return acc;
  }, [decorated]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`sm-chip transition-colors ${
                filter === f.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line-strong text-muted hover:text-ink"
              }`}
            >
              {f.label}
              <span className="text-faint">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="sm-btn ml-auto px-2 py-1.5"
          title="Refresh"
          aria-label="Refresh audit log"
        >
          <MdRefresh size={16} />
        </button>
      </div>

      <div className="overflow-x-auto border border-line">
        {visible.length === 0 ? (
          <p className="px-4 py-10 text-center font-mono text-sm text-muted">
            {loading ? "Loading…" : "No events."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-xs"
              >
                <span className="text-faint">
                  {formatTime(event.timestamp)}
                </span>
                <span
                  className={`font-bold uppercase ${CATEGORY_STYLE[event.category]}`}
                >
                  {event.action}
                </span>
                <span className="text-ink">{event.key_name || "—"}</span>
                <span className="text-muted">
                  token={event.token_name || "—"}
                </span>
                <span className="ml-auto text-faint">{event.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
