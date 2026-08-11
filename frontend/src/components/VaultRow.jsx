import {
  MdContentCopy,
  MdVisibility,
  MdVisibilityOff,
  MdDelete,
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
  onDelete,
}) {
  const { key, folder, id } = secret;
  const revealed = Boolean(reveal);
  const canWrite = role === "write";

  return (
    <tr className="group border-b border-line hover:bg-accent-soft/40">
      <td className="px-3 py-2 align-middle">
        <span className="font-mono text-sm font-bold text-ink">{key}</span>
      </td>
      <td className="px-3 py-2 align-middle">
        <span className="sm-chip border-line-strong text-muted">{folder}</span>
      </td>
      <td className="px-3 py-2 align-middle">
        {revealed ? (
          <span className="break-all font-mono text-sm text-ink">
            {reveal.value}
            <span className="ml-2 text-xs text-faint">
              re-mask {reveal.secondsLeft}s
            </span>
          </span>
        ) : (
          <span className="font-mono text-sm tracking-widest text-faint">
            {DOT_MASK}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 align-middle text-right font-mono text-xs text-muted">
        {relativeAge(createdAt)}
      </td>
      <td className="px-3 py-2 align-middle">
        {/* Actions are always visible on touch; fade-in on hover for pointers. */}
        <div className="flex items-center justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <button
            type="button"
            className="border border-line-strong p-1.5 text-muted hover:border-accent hover:text-accent disabled:opacity-50"
            onClick={() => onCopy(id)}
            disabled={busy}
            aria-label={`Copy ${key} in ${folder}`}
            title="Copy value (never rendered)"
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
