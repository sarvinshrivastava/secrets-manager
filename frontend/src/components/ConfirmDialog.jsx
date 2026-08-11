import { useEffect } from "react";

// Generic confirm modal (replaces DeleteDialog). Radius 0, hairline border,
// plain fixed overlay — no reactjs-popup so the design tokens are honoured.
export default function ConfirmDialog({
  open,
  title,
  body,
  mono,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md border border-line-strong bg-surface"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="border-b border-line px-5 py-3">
          <h3 className="font-mono text-sm font-semibold text-ink">{title}</h3>
        </div>
        <div className="px-5 py-4">
          {body && <p className="font-mono text-sm text-muted">{body}</p>}
          {mono && (
            <p className="mt-2 break-all border border-line bg-paper px-3 py-2 font-mono text-sm text-ink">
              {mono}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            className="sm-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "sm-btn-danger" : "sm-btn-accent"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
