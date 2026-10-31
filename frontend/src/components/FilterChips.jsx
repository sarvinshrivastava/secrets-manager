import { MdAdd } from "react-icons/md";

// Folder filter chips with live counts. Folders come from the server
// (GET /api/folders) — there is no localStorage folder mechanism. A folder
// exists once it holds a secret, so "+ Folder" opens Add secret with the new
// folder name field ready.
export default function FilterChips({
  folders,
  counts,
  total,
  active,
  onSelect,
  onAddFolder, // undefined for read-only tokens
}) {
  const chips = [
    { name: "All", count: total },
    ...folders.map((name) => ({
      name,
      count: counts[name] || 0,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => {
        const isActive = active === chip.name;
        return (
          <button
            key={chip.name}
            type="button"
            onClick={() => onSelect(chip.name)}
            title={chip.name}
            className={`sm-chip max-w-[14rem] transition-colors ${
              isActive
                ? "border-accent bg-accent-soft text-accent"
                : "border-line-strong text-muted hover:text-ink"
            }`}
          >
            <span className="min-w-0 truncate">{chip.name}</span>
            <span className="flex-none text-faint">{chip.count}</span>
          </button>
        );
      })}
      {onAddFolder && (
        <button
          type="button"
          onClick={onAddFolder}
          className="sm-chip border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:text-accent"
          title="Create a folder by adding its first secret"
        >
          <MdAdd size={14} />
          <span>New folder</span>
        </button>
      )}
    </div>
  );
}
