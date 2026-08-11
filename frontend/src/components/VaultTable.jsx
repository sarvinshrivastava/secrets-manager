import VaultRow from "./VaultRow.jsx";

export default function VaultTable({
  secrets,
  meta,
  reveals,
  role,
  busy,
  onCopy,
  onReveal,
  onMask,
  onDelete,
}) {
  if (secrets.length === 0) {
    return (
      <div className="border border-dashed border-line-strong px-4 py-12 text-center">
        <p className="font-mono text-sm text-muted">No secrets match.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line-strong bg-paper text-left">
            <th className="px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-faint">
              Key
            </th>
            <th className="px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-faint">
              Folder
            </th>
            <th className="px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-faint">
              Value
            </th>
            <th className="px-3 py-2 text-right font-mono text-xs font-semibold uppercase tracking-wide text-faint">
              Age
            </th>
            <th className="px-3 py-2 text-right font-mono text-xs font-semibold uppercase tracking-wide text-faint">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {secrets.map((secret) => (
            <VaultRow
              key={secret.id}
              secret={secret}
              createdAt={meta[secret.id]?.createdAt}
              reveal={reveals[secret.id] || null}
              role={role}
              busy={busy}
              onCopy={onCopy}
              onReveal={onReveal}
              onMask={onMask}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
