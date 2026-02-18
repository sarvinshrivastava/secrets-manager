import { MdMenu, MdRefresh, MdAdd } from "react-icons/md";

export default function DashboardHeader({
  searchTerm,
  onSearchChange,
  onCreateSecret,
  onRefresh,
  role,
  loading,
  onMenuClick,
}) {
  return (
    <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-1">
          <button
            onClick={onMenuClick}
            className="lg:hidden text-slate-600 hover:text-slate-900"
          >
            <MdMenu size={24} />
          </button>

          <div className="flex-1 min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">Secrets Dashboard</h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1 hidden sm:block">Manage your secure credentials</p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <div className="relative hidden md:block md:w-64 lg:w-72">
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(event) => onSearchChange(event.target.value)}
              className="input-field w-full text-sm"
            />
          </div>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="btn-secondary p-2"
            title="Refresh secrets"
          >
            <MdRefresh size={18} />
          </button>

          {role === "write" && (
            <button
              onClick={onCreateSecret}
              className="btn-primary flex items-center gap-1 sm:gap-2 px-3 py-2"
            >
              <MdAdd size={20} />
              <span className="hidden sm:inline">New Secret</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
