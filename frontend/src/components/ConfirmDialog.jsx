import { useEffect } from "react";
import { useBackdropClose } from "../hooks/useBackdropClose.js";

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
  layer = "z-40",
  onConfirm,
  onClose,
}) {
  // Escape and the backdrop are ignored while the action is in flight.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const backdrop = useBackdropClose(() => {
    if (!busy) onClose();
  });

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 ${layer} flex items-center justify-center bg-black/40 px-4`}
      {...backdrop}
      role="presentation"
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto border border-line-strong bg-surface"
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
            autoFocus={danger}
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
