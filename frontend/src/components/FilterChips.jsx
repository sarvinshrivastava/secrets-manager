// Folder filter chips with live counts. Folders come from the server
// (GET /api/folders) — there is no localStorage folder mechanism.
export default function FilterChips({
  folders,
  counts,
  total,
  active,
  onSelect,
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
            className={`sm-chip transition-colors ${
              isActive
                ? "border-accent bg-accent-soft text-accent"
                : "border-line-strong text-muted hover:text-ink"
            }`}
          >
            <span>{chip.name}</span>
            <span className="text-faint">{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}
