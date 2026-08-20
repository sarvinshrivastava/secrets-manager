import { useEffect, useRef } from "react";
import { Menu } from "@headlessui/react";
import {
  MdSearch,
  MdAdd,
  MdArrowDropDown,
  MdLightMode,
  MdDarkMode,
} from "react-icons/md";

const TABS = [
  { id: "vault", label: "Vault" },
  { id: "audit", label: "Audit" },
  { id: "settings", label: "Settings" },
];

function Wordmark() {
  return (
    <div className="flex items-center gap-2 select-none">
      <span className="flex h-7 w-7 items-center justify-center border border-accent bg-accent font-mono text-xs font-bold text-surface">
        SM
      </span>
      <span className="hidden font-mono text-sm font-semibold tracking-tight text-ink sm:inline">
        secret·manager
      </span>
    </div>
  );
}

export default function TopBar({
  view,
  onViewChange,
  searchTerm,
  onSearchChange,
  role,
  theme,
  onToggleTheme,
  onAddSingle,
  onAddBulk,
  dialogOpen,
}) {
  const canWrite = role === "write";
  const searchRef = useRef(null);

  // Cmd/Ctrl+K focuses the search box. preventDefault is required: browsers
  // bind the same chord to their own address-bar search. Skipped while a modal
  // is open, otherwise focus jumps behind the overlay.
  useEffect(() => {
    if (dialogOpen) return undefined;
    function onKey(event) {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey) return;
      if (event.key?.toLowerCase() !== "k") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen]);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5">
        <Wordmark />

        <nav className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onViewChange(tab.id)}
              className={`border-b-2 px-2 py-1 font-mono text-sm transition-colors ${
                view === tab.id
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="relative order-last w-full min-w-[12rem] flex-1 sm:order-none sm:w-auto">
          <MdSearch
            size={16}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            ref={searchRef}
            type="text"
            value={searchTerm}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search keys…  ⌘K"
            aria-label="Search keys"
            className="sm-input pl-7"
          />
        </div>

        <span
          className={`sm-chip ${
            canWrite
              ? "border-accent text-accent"
              : "border-line-strong text-muted"
          }`}
          title={`Token role: ${role || "unknown"}`}
        >
          {role || "…"}
        </span>

        <button
          type="button"
          onClick={onToggleTheme}
          className="sm-btn px-2 py-1.5"
          aria-label="Toggle color theme"
          title="Toggle theme"
        >
          {theme === "dark" ? (
            <MdLightMode size={16} />
          ) : (
            <MdDarkMode size={16} />
          )}
        </button>

        {canWrite && (
          <Menu as="div" className="relative">
            <div className="flex">
              <button
                type="button"
                onClick={onAddSingle}
                className="sm-btn-accent border-r-0"
              >
                <MdAdd size={16} />
                Add
              </button>
              <Menu.Button
                className="sm-btn-accent px-1.5"
                aria-label="Add options"
              >
                <MdArrowDropDown size={18} />
              </Menu.Button>
            </div>
            <Menu.Items className="absolute right-0 z-30 mt-1 w-40 border border-line-strong bg-surface py-1 shadow-lg focus:outline-none">
              <Menu.Item>
                {({ active }) => (
                  <button
                    type="button"
                    onClick={onAddSingle}
                    className={`block w-full px-3 py-2 text-left font-mono text-sm text-ink ${
                      active ? "bg-accent-soft" : ""
                    }`}
                  >
                    Add single
                  </button>
                )}
              </Menu.Item>
              <Menu.Item>
                {({ active }) => (
                  <button
                    type="button"
                    onClick={onAddBulk}
                    className={`block w-full px-3 py-2 text-left font-mono text-sm text-ink ${
                      active ? "bg-accent-soft" : ""
                    }`}
                  >
                    Paste .env
                  </button>
                )}
              </Menu.Item>
            </Menu.Items>
          </Menu>
        )}
      </div>
    </header>
  );
}
