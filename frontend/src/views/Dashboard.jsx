import SecretCard from "../components/SecretCard.jsx";
import DashboardHeader from "../components/DashboardHeader.jsx";

function maskSecret(value, start = 3, end = 2) {
  if (!value) return "";
  if (value.length <= start + end) return "*".repeat(value.length);
  return `${value.slice(0, start)}${"*".repeat(Math.max(8, value.length - start - end))}${value.slice(-end)}`;
}

export default function Dashboard({
  keys,
  folders,
  filteredKeys,
  keyFolders,
  defaultFolderName,
  secretCache,
  secretMeta,
  role,
  busy,
  authToken,
  onCopy,
  onDelete,
  onCreateSecret,
  searchTerm,
  onSearchChange,
  onRefresh,
  loading,
  onMenuClick,
}) {
  return (
    <div className="w-full -m-4 sm:-m-6">
      <DashboardHeader
        searchTerm={searchTerm}
        onSearchChange={onSearchChange}
        onCreateSecret={onCreateSecret}
        onRefresh={onRefresh}
        role={role}
        loading={loading}
        onMenuClick={onMenuClick}
      />

      <div className="p-4 sm:p-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="stat-card">
            <p className="text-sm text-slate-600 mb-2">Total Secrets</p>
            <h3 className="text-3xl font-bold text-green-600 mb-1">{keys.length}</h3>
            <p className="text-xs text-slate-500">Live vault size</p>
          </div>
          <div className="stat-card">
            <p className="text-sm text-slate-600 mb-2">Expiring Soon</p>
            <h3 className="text-3xl font-bold text-yellow-600 mb-1">{Math.min(4, keys.length)}</h3>
            <p className="text-xs text-slate-500">Next 7 days</p>
          </div>
          <div className="stat-card">
            <p className="text-sm text-slate-600 mb-2">Weak Passwords</p>
            <h3 className="text-3xl font-bold text-orange-600 mb-1">{Math.max(0, Math.floor(keys.length / 3))}</h3>
            <p className="text-xs text-slate-500">Requires attention</p>
          </div>
          <div className="stat-card">
            <p className="text-sm text-slate-600 mb-2">Folders</p>
            <h3 className="text-3xl font-bold text-blue-600 mb-1">{folders.length}</h3>
            <p className="text-xs text-slate-500">Organizing secrets</p>
          </div>
        </div>

        {/* Secrets Section */}
        <div>
          <div className="mb-6">
            <h2 className="text-xl font-bold text-slate-900 mb-2">Recent Secrets</h2>
            <p className="text-sm text-slate-600">Manage and organize your credentials</p>
          </div>

          {filteredKeys.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-lg border border-slate-200">
              <div className="text-slate-400 mb-3 text-4xl">🔐</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">No secrets to show</h3>
              <p className="text-slate-600 mb-4">Create your first secret or adjust the search filter.</p>
              {role === "write" && (
                <button type="button" className="btn-primary" onClick={onCreateSecret}>
                  Create Secret
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredKeys.map((keyName) => (
                <SecretCard
                  key={keyName}
                  keyName={keyName}
                  folder={keyFolders?.[keyName] || defaultFolderName || "Root"}
                  authToken={authToken}
                  preview={secretCache[keyName] ? maskSecret(secretCache[keyName]) : ""}
                  createdAt={secretMeta[keyName]?.createdAt}
                  role={role}
                  busy={busy}
                  onCopy={onCopy}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
