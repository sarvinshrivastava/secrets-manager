import { useEffect, useState } from "react";
import { MdMenu, MdRefresh } from "react-icons/md";
import { toast } from "react-hot-toast";
import { listAuditLogs } from "../api.js";

function formatAction(action) {
  const labels = {
    secret_created: "Secret Created",
    secret_updated: "Secret Modified",
    secret_deleted: "Secret Deleted",
    folder_renamed: "Folder Renamed",
    export_env: "Export",
    import_env: "Import",
    get_secret: "Secret Fetched",
    list_keys: "Keys Listed",
    auth: "Authentication",
    authz: "Authorization",
    rate_limit: "Rate Limited",
    token_created: "Token Created",
    token_revoked: "Token Revoked",
    token_rotated: "Token Rotated",
  };
  if (labels[action]) return labels[action];
  return String(action || "unknown")
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function AuditLogs({ token, onMenuClick }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const payload = await listAuditLogs(token, { limit: 200 });
      setEvents(payload.events || []);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      toast.error(`Failed to load audit logs: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [token]);

  return (
    <div className="w-full">
      <div>
        <div className="mb-6 flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="lg:hidden text-slate-600 hover:text-slate-900"
          >
            <MdMenu size={24} />
          </button>
          <div className="flex-1">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Audit Logs</h2>
            <p className="text-sm sm:text-base text-slate-600 hidden sm:block">
              Track all activity and changes to your secrets
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="btn-secondary p-2"
            title="Refresh audit logs"
          >
            <MdRefresh size={18} />
          </button>
        </div>

        <div className="stat-card">
          <div className="space-y-1 mb-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">Activity Log</h3>
              {lastUpdated && (
                <span className="text-xs text-slate-500">
                  Updated {new Date(lastUpdated).toLocaleTimeString()}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500">Last {events.length} events</p>
          </div>

          {loading && events.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">Loading audit logs...</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No audit events found.</p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-2 sm:px-4 font-semibold text-slate-900">Timestamp</th>
                    <th className="text-left py-3 px-2 sm:px-4 font-semibold text-slate-900">Action</th>
                    <th className="text-left py-3 px-2 sm:px-4 font-semibold text-slate-900">Key</th>
                    <th className="text-left py-3 px-2 sm:px-4 font-semibold text-slate-900">Token</th>
                    <th className="text-left py-3 px-2 sm:px-4 font-semibold text-slate-900">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 px-2 sm:px-4 text-slate-600 whitespace-nowrap">
                        {new Date(event.timestamp).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-3 px-2 sm:px-4 text-slate-900 font-medium">
                        {formatAction(event.action)}
                      </td>
                      <td className="py-3 px-2 sm:px-4 font-mono text-slate-700 truncate max-w-[120px] sm:max-w-none">
                        {event.key_name || "—"}
                      </td>
                      <td className="py-3 px-2 sm:px-4 text-slate-600 truncate max-w-[100px]">
                        {event.token_name || "—"}
                      </td>
                      <td className="py-3 px-2 sm:px-4">
                        <span
                          className={`badge text-xs ${
                            event.status === "ok" || event.status === "success"
                              ? "badge-success"
                              : event.status === "missing"
                              ? "badge-warning"
                              : "badge-error"
                          }`}
                        >
                          {event.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
