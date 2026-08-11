import { useEffect, useState } from "react";
import { MdClose } from "react-icons/md";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Single-secret add modal. Radius 0, mono-first.
export default function AddSingleDialog({
  open,
  folders,
  defaultFolder,
  busy,
  onSubmit, // ({ key, value, folder }) => Promise
  onClose,
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setKey("");
      setValue("");
      setFolder(defaultFolder);
      setError("");
    }
  }, [open, defaultFolder]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!KEY_RE.test(trimmedKey)) {
      setError("Key must match [A-Za-z_][A-Za-z0-9_]*");
      return;
    }
    if (!value) {
      setError("Value is required");
      return;
    }
    setError("");
    onSubmit({
      key: trimmedKey,
      value,
      folder: folder.trim() || defaultFolder,
    });
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <form
        className="w-full max-w-lg border border-line-strong bg-surface"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="font-mono text-sm font-semibold text-ink">
            Add secret
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink"
            aria-label="Close"
          >
            <MdClose size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint">
              Key
            </label>
            <input
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="DATABASE_URL"
              className="sm-input"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint">
              Value
            </label>
            <textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={3}
              placeholder="value…"
              className="sm-input resize-y"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint">
              Folder
            </label>
            <input
              list="add-single-folders"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className="sm-input"
            />
            <datalist id="add-single-folders">
              {folders.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          {error && <p className="font-mono text-xs text-danger">{error}</p>}
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
          <button type="submit" className="sm-btn-accent" disabled={busy}>
            {busy ? "Saving…" : "Add secret"}
          </button>
        </div>
      </form>
    </div>
  );
}
