import { useEffect, useState } from "react";
import { MdClose } from "react-icons/md";
import FolderSelect from "./FolderSelect.jsx";
import { useModalGuard } from "../hooks/useModalGuard.jsx";
import { useBackdropClose } from "../hooks/useBackdropClose.js";
import { isValidFolderName, FOLDER_RULE_HINT } from "../lib/folders.js";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Edit a secret in place: rename the key, move it to another folder, and/or
// replace its value — one atomic PATCH. The value starts EMPTY ("keep current");
// "Show current value" fetches it fresh (audited as a read) and fills the box.
// Only changed fields are sent; plaintext is cleared when the dialog closes.
export default function EditSecretDialog({
  open,
  secret, // { key, folder } | null
  folders,
  busy,
  onLoadValue, // (secret) => Promise<string>  (always fresh, never cached)
  onSubmit, // (patch) => Promise<string | null>  (error message or null)
  onClose,
}) {
  const [key, setKey] = useState("");
  const [folder, setFolder] = useState("");
  const [value, setValue] = useState("");
  const [fetched, setFetched] = useState(null); // plaintext last loaded, or null
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const origKey = secret?.key ?? "";
  const origFolder = secret?.folder ?? "";

  useEffect(() => {
    if (open && secret) {
      setKey(secret.key);
      setFolder(secret.folder);
    } else {
      setKey("");
      setFolder("");
    }
    // Never leave plaintext behind in state, open or not.
    setValue("");
    setFetched(null);
    setLoading(false);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, secret?.key, secret?.folder]);

  // A value counts as changed only when non-empty and different from what was
  // loaded (revealing it and leaving it alone is NOT an edit).
  const valueChanged = value !== "" && value !== fetched;
  const keyChanged = key.trim() !== origKey;
  const folderChanged = folder.trim() !== origFolder;
  const dirty = keyChanged || folderChanged || valueChanged;

  const { requestClose, discardDialog } = useModalGuard({
    open,
    dirty,
    onClose,
  });
  const backdrop = useBackdropClose(requestClose);

  if (!open || !secret) return null;

  async function showCurrent() {
    setLoading(true);
    setError("");
    try {
      const current = await onLoadValue(secret);
      setFetched(current);
      setValue(current);
    } catch (err) {
      if (err.message !== "Unauthorized") {
        setError(`Could not load value: ${err.message}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextKey = key.trim();
    const nextFolder = folder.trim();
    if (!KEY_RE.test(nextKey) || nextKey.length > 128) {
      setError("Key must match [A-Za-z_][A-Za-z0-9_]* (max 128)");
      return;
    }
    if (!isValidFolderName(nextFolder)) {
      setError(nextFolder ? FOLDER_RULE_HINT : "Choose a folder");
      return;
    }
    const patch = {};
    if (nextKey !== origKey) patch.key = nextKey;
    if (nextFolder !== origFolder) patch.folder = nextFolder;
    if (valueChanged) patch.value = value;
    if (Object.keys(patch).length === 0) {
      setError("Nothing changed");
      return;
    }
    setError("");
    const failure = await onSubmit(patch);
    if (failure) setError(failure);
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
          aria-label="Edit secret"
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 className="min-w-0 truncate font-mono text-sm font-semibold text-ink">
              Edit secret
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
                htmlFor="edit-secret-key"
                className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
              >
                Key
              </label>
              <input
                id="edit-secret-key"
                autoFocus
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="sm-input"
                spellCheck={false}
              />
            </div>
            <div>
              <label
                htmlFor="edit-secret-folder"
                className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
              >
                Folder
              </label>
              <FolderSelect
                id="edit-secret-folder"
                value={folder}
                onChange={setFolder}
                folders={folders}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="edit-secret-value"
                  className="block font-mono text-xs uppercase tracking-wide text-faint"
                >
                  Value
                </label>
                {fetched === null && (
                  <button
                    type="button"
                    className="font-mono text-xs text-accent hover:underline disabled:opacity-50"
                    onClick={showCurrent}
                    disabled={loading || busy}
                  >
                    {loading ? "Loading…" : "Show current value"}
                  </button>
                )}
              </div>
              <textarea
                id="edit-secret-value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                rows={3}
                placeholder="Leave blank to keep the current value"
                className="sm-input resize-y"
                spellCheck={false}
              />
            </div>
            {(keyChanged || folderChanged) && (
              <p className="border border-warn bg-paper px-3 py-2 font-mono text-xs text-warn">
                Renaming or moving changes the secret&apos;s path. Anything that
                fetches {origFolder} / {origKey} will get a 404 until updated.
              </p>
            )}
            {error && (
              <p role="alert" className="font-mono text-xs text-danger">
                {error}
              </p>
            )}
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
            <button
              type="submit"
              className="sm-btn-accent"
              disabled={busy || !dirty}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
      {discardDialog}
    </>
  );
}
