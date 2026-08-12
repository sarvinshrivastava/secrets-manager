import { useEffect, useMemo, useState } from "react";
import { MdClose } from "react-icons/md";
import { parseEnvText } from "../lib/parseEnv.js";
import { DOT_MASK } from "../lib/format.js";

const STATUS_STYLE = {
  add: "border-accent text-accent",
  empty: "border-warn text-warn",
  exists: "border-warn text-warn",
  invalid: "border-danger text-danger",
  shadowed: "border-line-strong text-faint",
};

// Full-width sheet: paste .env on the left, live verification ledger on the
// right. Nothing hits the server until the commit button.
export default function BulkAddSheet({
  open,
  folders,
  defaultFolder,
  secrets: allSecrets = [], // full vault list [{ key, folder }]
  busy,
  onCommit, // ({ folder, secrets, overwrite }) => Promise
  onClose,
}) {
  const [text, setText] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const [showValues, setShowValues] = useState(false);
  const [overwrite, setOverwrite] = useState(() => new Set()); // keys to overwrite

  useEffect(() => {
    if (open) {
      setText("");
      setFolder(defaultFolder);
      setShowValues(false);
      setOverwrite(new Set());
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

  // A bulk paste targets ONE folder. Scope the "already exists" set to the
  // selected folder so a key present in another folder is not falsely skipped.
  // Recomputed whenever the folder selector or the vault list changes.
  const existingKeys = useMemo(
    () =>
      new Set(allSecrets.filter((s) => s.folder === folder).map((s) => s.key)),
    [allSecrets, folder],
  );

  // Re-parse on every keystroke.
  const rows = useMemo(
    () => parseEnvText(text, existingKeys),
    [text, existingKeys],
  );

  function toggleOverwrite(key) {
    setOverwrite((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Rows we will actually send: addable (add|empty) always, plus exists rows
  // whose overwrite toggle is on.
  const { secrets, overwriteKeys, count } = useMemo(() => {
    const out = [];
    const ow = [];
    rows.forEach((row) => {
      if (row.status === "add" || row.status === "empty") {
        out.push({ key: row.key, value: row.value });
      } else if (row.status === "exists" && overwrite.has(row.key)) {
        out.push({ key: row.key, value: row.value });
        ow.push(row.key);
      }
    });
    return { secrets: out, overwriteKeys: ow, count: out.length };
  }, [rows, overwrite]);

  if (!open) return null;

  const tally = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink/40">
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="font-mono text-sm font-semibold text-ink">
            Paste .env
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

        {/* Body: paste | ledger */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
          <div className="flex min-h-0 flex-col border-b border-line md:border-b-0 md:border-r">
            <div className="border-b border-line px-4 py-2 font-mono text-xs uppercase tracking-wide text-faint">
              Paste
            </div>
            <textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={
                "# paste your .env here\nAPI_KEY=abc123\nDB_URL=postgres://…"
              }
              className="min-h-0 flex-1 resize-none bg-paper px-4 py-3 font-mono text-sm text-ink outline-none placeholder:text-faint"
              spellCheck={false}
            />
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <span className="font-mono text-xs uppercase tracking-wide text-faint">
                Verify
              </span>
              <span className="font-mono text-xs text-muted">
                {rows.length} lines · {tally.add || 0} add · {tally.exists || 0}{" "}
                exists · {tally.invalid || 0} invalid
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rows.length === 0 ? (
                <p className="px-4 py-8 text-center font-mono text-sm text-faint">
                  Nothing parsed yet.
                </p>
              ) : (
                <table className="w-full border-collapse">
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={`${row.line}-${row.key}-${index}`}
                        className="border-b border-line align-top"
                      >
                        <td className="px-2 py-1.5 text-right font-mono text-xs text-faint">
                          {row.line}
                        </td>
                        <td className="px-2 py-1.5">
                          <span
                            className={`font-mono text-sm ${
                              row.status === "shadowed"
                                ? "text-faint line-through"
                                : "font-bold text-ink"
                            }`}
                          >
                            {row.key || "—"}
                          </span>
                          {row.reason && (
                            <div className="font-mono text-xs text-muted">
                              {row.reason}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-sm text-muted">
                          {row.status === "invalid" ||
                          row.status === "empty" ? (
                            ""
                          ) : showValues ? (
                            <span className="break-all text-ink">
                              {row.value}
                            </span>
                          ) : (
                            <span className="tracking-widest text-faint">
                              {DOT_MASK}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <span
                            className={`sm-chip ${STATUS_STYLE[row.status]}`}
                          >
                            {row.status}
                          </span>
                          {row.status === "exists" && (
                            <label className="mt-1 flex items-center justify-end gap-1 font-mono text-xs text-muted">
                              <input
                                type="checkbox"
                                checked={overwrite.has(row.key)}
                                onChange={() => toggleOverwrite(row.key)}
                              />
                              overwrite
                            </label>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <label className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-faint">
            Folder
            <input
              list="bulk-folders"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              className="sm-input w-40 normal-case"
            />
            <datalist id="bulk-folders">
              {folders.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>

          <label className="flex items-center gap-2 font-mono text-xs text-muted">
            <input
              type="checkbox"
              checked={showValues}
              onChange={(event) => setShowValues(event.target.checked)}
            />
            show values
          </label>

          <div className="ml-auto flex items-center gap-2">
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
              className="sm-btn-accent"
              disabled={busy || count === 0}
              onClick={() =>
                onCommit({
                  folder: folder.trim() || defaultFolder,
                  secrets,
                  overwrite: overwriteKeys,
                })
              }
            >
              {busy
                ? "Committing…"
                : `Add ${count} secret${count === 1 ? "" : "s"} → ${folder.trim() || defaultFolder}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
