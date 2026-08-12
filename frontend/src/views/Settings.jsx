import { useEffect, useState } from "react";
import { MdRefresh, MdContentCopy, MdClose } from "react-icons/md";
import { toast } from "react-hot-toast";
import {
  exportSecrets,
  listTokens,
  createToken,
  revokeToken,
  rotateToken,
} from "../api.js";

const EXPIRY_OPTIONS = [
  { label: "Never", value: "" },
  { label: "7 days", value: String(7 * 86400) },
  { label: "30 days", value: String(30 * 86400) },
  { label: "90 days", value: String(90 * 86400) },
  { label: "1 year", value: String(365 * 86400) },
];

function tokenStatus(t) {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && new Date() > new Date(t.expires_at)) return "expired";
  return "active";
}

const STATUS_STYLE = {
  active: "border-ok text-ok",
  expired: "border-warn text-warn",
  revoked: "border-danger text-danger",
};

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="font-mono text-xs uppercase tracking-wide text-faint">
        {label}
      </dt>
      <dd className="col-span-2 font-mono text-sm text-ink">{children}</dd>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="border border-line bg-surface">
      <div className="border-b border-line px-4 py-2">
        <h3 className="font-mono text-sm font-semibold text-ink">{title}</h3>
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

// Full-value reveal modal (shown once after create/rotate — value is never
// retrievable again).
function TokenValueModal({ open, label, value, onClose }) {
  if (!open) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Token copied");
    } catch {
      toast.error("Clipboard unavailable — copy manually");
    }
  }
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg border border-line-strong bg-surface"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="font-mono text-sm font-semibold text-ink">{label}</h3>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink"
            aria-label="Close"
          >
            <MdClose size={18} />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <p className="border border-warn bg-paper px-3 py-2 font-mono text-xs text-warn">
            Copy this now — it is shown only once.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all border border-line bg-paper px-3 py-2 font-mono text-xs text-ink">
              {value}
            </code>
            <button onClick={copy} className="sm-btn" aria-label="Copy token">
              <MdContentCopy size={15} />
            </button>
          </div>
        </div>
        <div className="flex justify-end border-t border-line px-4 py-3">
          <button className="sm-btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Settings({
  tokenName,
  role,
  token,
  folders,
  defaultFolder,
  onDefaultFolderChange,
  onLogout,
}) {
  const canWrite = role === "write";

  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("read");
  const [newExpiry, setNewExpiry] = useState("");
  const [scopeAll, setScopeAll] = useState(true);
  const [scopeFolders, setScopeFolders] = useState(() => new Set());
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState(null); // { label, value }

  function toggleScopeFolder(name) {
    setScopeFolders((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function loadTokens() {
    setTokensLoading(true);
    try {
      const payload = await listTokens(token);
      setTokens(payload.tokens || []);
    } catch (error) {
      if (error.message !== "Unauthorized") {
        toast.error(`Failed to load tokens: ${error.message}`);
      }
    } finally {
      setTokensLoading(false);
    }
  }

  useEffect(() => {
    if (canWrite) loadTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, canWrite]);

  async function handleCreate(event) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      toast.error("Token name is required");
      return;
    }
    const scope = scopeAll ? undefined : Array.from(scopeFolders);
    if (!scopeAll && scope.length === 0) {
      toast.error("Pick at least one folder or choose all folders");
      return;
    }
    setCreating(true);
    try {
      const payload = await createToken(
        token,
        name,
        newRole,
        newExpiry ? Number(newExpiry) : undefined,
        scope,
      );
      setRevealed({
        label: `Token "${payload.name}" created`,
        value: payload.token,
      });
      setNewName("");
      setNewRole("read");
      setNewExpiry("");
      setScopeAll(true);
      setScopeFolders(new Set());
      await loadTokens();
    } catch (error) {
      toast.error(`Create failed: ${error.message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleRotate(name) {
    if (
      !window.confirm(
        `Rotate "${name}"? The old value stops working immediately.`,
      )
    )
      return;
    try {
      const payload = await rotateToken(token, name);
      setRevealed({ label: `Token "${name}" rotated`, value: payload.token });
      await loadTokens();
    } catch (error) {
      toast.error(`Rotate failed: ${error.message}`);
    }
  }

  async function handleRevoke(name) {
    if (!window.confirm(`Revoke "${name}"? This cannot be undone.`)) return;
    try {
      await revokeToken(token, name);
      toast.success(`Token "${name}" revoked`);
      await loadTokens();
    } catch (error) {
      toast.error(`Revoke failed: ${error.message}`);
    }
  }

  async function handleExport() {
    try {
      const envText = await exportSecrets(token);
      const blob = new Blob([envText], { type: "text/plain;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "secrets.env";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      toast.success("Exported .env");
    } catch (error) {
      toast.error(`Export failed: ${error.message}`);
    }
  }

  const activeWriteCount = tokens.filter(
    (t) => t.role === "write" && tokenStatus(t) === "active",
  ).length;

  return (
    <div className="space-y-4">
      <TokenValueModal
        open={Boolean(revealed)}
        label={revealed?.label || ""}
        value={revealed?.value || ""}
        onClose={() => setRevealed(null)}
      />

      <Section title="Identity">
        <dl>
          <Row label="Token name">{tokenName || "—"}</Row>
          <Row label="Role">
            <span
              className={`sm-chip ${canWrite ? "border-accent text-accent" : "border-line-strong text-muted"}`}
            >
              {role}
            </span>
          </Row>
        </dl>
      </Section>

      <Section title="Default folder">
        <p className="mb-2 font-mono text-xs text-muted">
          Preselected when adding secrets. Stored in this browser only.
        </p>
        <input
          list="settings-folders"
          value={defaultFolder}
          onChange={(event) => onDefaultFolderChange(event.target.value)}
          className="sm-input max-w-xs"
        />
        <datalist id="settings-folders">
          {folders.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Section>

      {canWrite && (
        <Section title="Export">
          <p className="mb-2 font-mono text-xs text-muted">
            Download every secret as a .env file. Requires a write token.
          </p>
          <button
            type="button"
            className="sm-btn-accent"
            onClick={handleExport}
          >
            Export .env
          </button>
        </Section>
      )}

      {canWrite && (
        <Section title="Access tokens">
          <form
            onSubmit={handleCreate}
            className="mb-4 space-y-3 border border-line bg-paper p-3"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                type="text"
                placeholder="name e.g. ci-reader"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="sm-input"
                required
              />
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className="sm-input"
              >
                <option value="read">read</option>
                <option value="write">write</option>
              </select>
              <select
                value={newExpiry}
                onChange={(e) => setNewExpiry(e.target.value)}
                className="sm-input"
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="space-y-2">
              <legend className="font-mono text-xs uppercase tracking-wide text-faint">
                Scope
              </legend>
              <label className="flex items-center gap-2 font-mono text-xs text-muted">
                <input
                  type="checkbox"
                  checked={scopeAll}
                  onChange={(e) => setScopeAll(e.target.checked)}
                />
                All folders (*)
              </label>
              {!scopeAll && (
                <div className="flex flex-wrap gap-3 border border-line bg-surface px-3 py-2">
                  {folders.length === 0 ? (
                    <span className="font-mono text-xs text-faint">
                      No folders yet.
                    </span>
                  ) : (
                    folders.map((name) => (
                      <label
                        key={name}
                        className="flex items-center gap-1 font-mono text-xs text-muted"
                      >
                        <input
                          type="checkbox"
                          checked={scopeFolders.has(name)}
                          onChange={() => toggleScopeFolder(name)}
                        />
                        {name}
                      </label>
                    ))
                  )}
                </div>
              )}
            </fieldset>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="sm-btn-accent"
                disabled={creating}
              >
                {creating ? "Creating…" : "Create token"}
              </button>
              <button
                type="button"
                className="sm-btn px-2 py-1.5"
                onClick={loadTokens}
                disabled={tokensLoading}
                aria-label="Refresh tokens"
              >
                <MdRefresh size={16} />
              </button>
            </div>
          </form>

          <div className="overflow-x-auto border border-line">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line-strong bg-paper text-left">
                  {["Name", "Role", "Expires", "Status", ""].map((h, i) => (
                    <th
                      key={h || i}
                      className="px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-faint"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokens.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center font-mono text-sm text-muted"
                    >
                      {tokensLoading ? "Loading…" : "No tokens."}
                    </td>
                  </tr>
                ) : (
                  tokens.map((t) => {
                    const status = tokenStatus(t);
                    const isLastActiveWrite =
                      t.role === "write" &&
                      status === "active" &&
                      activeWriteCount <= 1;
                    return (
                      <tr key={t.name} className="border-b border-line">
                        <td className="px-3 py-2 font-mono text-sm font-bold text-ink">
                          {t.name}
                        </td>
                        <td className="px-3 py-2 font-mono text-sm text-muted">
                          {t.role}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted">
                          {t.expires_at
                            ? new Date(t.expires_at).toLocaleDateString()
                            : "Never"}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`sm-chip ${STATUS_STYLE[status]}`}>
                            {status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {status === "active" && (
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                className="sm-btn px-2 py-1 text-xs"
                                onClick={() => handleRotate(t.name)}
                              >
                                Rotate
                              </button>
                              <button
                                type="button"
                                className="sm-btn-danger px-2 py-1 text-xs disabled:opacity-40"
                                onClick={() => handleRevoke(t.name)}
                                disabled={isLastActiveWrite}
                                title={
                                  isLastActiveWrite
                                    ? "Cannot revoke the last active write token"
                                    : "Revoke"
                                }
                              >
                                Revoke
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <section className="border border-danger bg-surface">
        <div className="border-b border-danger px-4 py-2">
          <h3 className="font-mono text-sm font-semibold text-danger">
            Danger zone
          </h3>
        </div>
        <div className="px-4 py-3">
          <button type="button" className="sm-btn-danger" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
