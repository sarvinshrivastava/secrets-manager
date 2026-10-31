import {
  MdContentCopy,
  MdVisibility,
  MdVisibilityOff,
  MdDelete,
  MdEdit,
} from "react-icons/md";
import { relativeAge, DOT_MASK } from "../lib/format.js";

// One dense ledger row. Reveal is self-expiring and driven by the parent
// (Vault) so that Esc can mask every row at once.
export default function VaultRow({
  secret,
  createdAt,
  reveal, // null, or { value, secondsLeft }
  role,
  busy,
  onCopy,
  onReveal,
  onMask,
  onEdit,
  onDelete,
}) {
  const { key, folder, id } = secret;
  const revealed = Boolean(reveal);
  const canWrite = role === "write";

  return (
    <tr className="group border-b border-line hover:bg-accent-soft">
      <td className="px-3 py-2 align-middle">
        <span
          className="block truncate font-mono text-sm font-bold text-ink"
          title={key}
        >
          {key}
        </span>
      </td>
      <td className="px-3 py-2 align-middle">
        <span
          className="sm-chip max-w-full border-line-strong text-muted"
          title={folder}
        >
          <span className="min-w-0 truncate">{folder}</span>
        </span>
      </td>
      {/* Fixed-width cell: dots and the revealed value both occupy one line and
          truncate, so toggling reveal never resizes the column or reflows the
          table. The countdown sits in its own fixed slot. */}
      <td className="px-3 py-2 align-middle">
        {revealed ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
              {reveal.value}
            </span>
            <span className="flex-none font-mono text-xs tabular-nums text-faint">
              {reveal.secondsLeft}s
            </span>
          </div>
        ) : (
          <span className="block truncate font-mono text-sm tracking-widest text-faint">
            {DOT_MASK}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-middle text-right font-mono text-xs text-muted">
        {relativeAge(createdAt)}
      </td>
      <td className="px-3 py-2 align-middle">
        {/* Actions are always visible on touch; fade-in on hover for pointers. */}
        <div className="flex items-center justify-end gap-1 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
          <button
            type="button"
            className="border border-line-strong p-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50"
            onClick={() => onCopy(id)}
            disabled={busy}
            aria-label={`Copy ${key} in ${folder}`}
            title="Copy value"
          >
            <MdContentCopy size={15} />
          </button>
          <button
            type="button"
            className="border border-line-strong p-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50"
            onClick={() => (revealed ? onMask(id) : onReveal(id))}
            disabled={busy}
            aria-label={`${revealed ? "Mask" : "Reveal"} ${key} in ${folder}`}
            title={revealed ? "Mask" : "Reveal for 15s"}
          >
            {revealed ? (
              <MdVisibilityOff size={15} />
            ) : (
              <MdVisibility size={15} />
            )}
          </button>
          {canWrite && (
            <button
              type="button"
              className="border border-line-strong p-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50"
              onClick={() => onEdit(secret)}
              disabled={busy}
              aria-label={`Edit ${key} in ${folder}`}
              title="Edit key, folder or value"
            >
              <MdEdit size={15} />
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              className="border border-line-strong p-1.5 text-muted hover:border-danger hover:text-danger disabled:opacity-50"
              onClick={() => onDelete(secret)}
              disabled={busy}
              aria-label={`Delete ${key} in ${folder}`}
              title="Delete"
            >
              <MdDelete size={15} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
