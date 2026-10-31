import { useEffect, useState } from "react";
import { MdClose } from "react-icons/md";
import FolderSelect from "./FolderSelect.jsx";
import { useModalGuard } from "../hooks/useModalGuard.jsx";
import { useBackdropClose } from "../hooks/useBackdropClose.js";
import { isValidFolderName, FOLDER_RULE_HINT } from "../lib/folders.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Single-secret add modal. Radius 0, mono-first.
export default function AddSingleDialog({
  open,
  folders,
  defaultFolder,
  initialFolder = "", // preset (overrides defaultFolder on open)
  initialFolderMode = "select", // "new" opens the folder field as a name input
  busy,
  onSubmit, // ({ key, value, folder }) => Promise
  onClose,
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const [error, setError] = useState("");

  // Reset only when the dialog opens: a folders/default refresh while open must
  // not clobber what the user typed.
  useEffect(() => {
    if (open) {
      setKey("");
      setValue("");
      // "New folder" mode starts with an empty name box, not the default folder.
      setFolder(
        initialFolderMode === "new" ? initialFolder : initialFolder || defaultFolder,
      );
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const { requestClose, discardDialog } = useModalGuard({
    open,
    dirty: key !== "" || value !== "",
    onClose,
  });
  const backdrop = useBackdropClose(requestClose);

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
    const trimmedFolder = folder.trim();
    if (!isValidFolderName(trimmedFolder)) {
      setError(trimmedFolder ? FOLDER_RULE_HINT : "Choose a folder");
      return;
    }
    setError("");
    onSubmit({ key: trimmedKey, value, folder: trimmedFolder });
  }

  return (
    <>
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      {...backdrop}
      role="presentation"
    >
      <form
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto border border-line-strong bg-surface"
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-secret-title"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3
            id="add-secret-title"
            className="font-mono text-sm font-semibold text-ink"
          >
            Add secret
          </h3>
          <button
            type="button"
            onClick={requestClose}
            className="p-2 text-muted hover:text-ink"
            aria-label="Close"
          >
            <MdClose size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label
              htmlFor="add-secret-key"
              className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
            >
              Key
            </label>
            <input
              id="add-secret-key"
              autoFocus
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="DATABASE_URL"
              className="sm-input"
            />
          </div>
          <div>
            <label
              htmlFor="add-secret-value"
              className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
            >
              Value
            </label>
            <textarea
              id="add-secret-value"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={3}
              placeholder="value…"
              className="sm-input resize-y"
            />
          </div>
          <div>
            <label
              htmlFor="add-secret-folder"
              className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
            >
              Folder
            </label>
            <FolderSelect
              id="add-secret-folder"
              value={folder}
              onChange={setFolder}
              folders={folders}
              startInNew={initialFolderMode === "new"}
            />
          </div>
          {error && <p className="font-mono text-xs text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            className="sm-btn"
            onClick={requestClose}
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
    {discardDialog}
    </>
  );
}
