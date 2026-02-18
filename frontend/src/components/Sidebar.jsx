import { MdDashboard, MdLock, MdHistory, MdSettings, MdLogout } from "react-icons/md";

export default function Sidebar({ activeView, onViewChange, onLogout, role, isOpen, onClose }) {
  const items = [
    { id: "dashboard", label: "Dashboard", icon: MdDashboard },
    { id: "secrets", label: "All Secrets", icon: MdLock },
    { id: "audit", label: "Audit Logs", icon: MdHistory },
    { id: "settings", label: "Settings", icon: MdSettings },
  ];

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        w-64 bg-white border-r border-slate-200 h-screen flex flex-col z-50
        fixed lg:sticky top-0
        transition-transform duration-300 ease-in-out
        ${isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
      `}>
        <div className="p-6 border-b border-slate-200">
          <div className="w-10 h-10 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-lg">
            S
          </div>
          <h1 className="mt-3 text-xl font-bold text-slate-900">Secrets</h1>
        </div>

        <nav className="flex-1 p-4 overflow-y-auto">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`sidebar-nav-item w-full text-left mb-2 ${isActive ? "active" : ""}`}
              >
                <Icon size={20} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200">
          {role && (
            <div className="mb-4 p-3 bg-slate-50 rounded-lg">
              <p className="text-xs text-slate-600">Role</p>
              <p className="font-semibold text-slate-900 capitalize">{role}</p>
            </div>
          )}
          <button
            onClick={onLogout}
            className="sidebar-nav-item w-full text-left text-red-600 hover:bg-red-50"
          >
            <MdLogout size={20} />
            <span>Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
}
