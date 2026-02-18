import { useEffect, useState } from "react";
import Popup from "reactjs-popup";
import { MdMenu, MdRefresh, MdContentCopy, MdClose } from "react-icons/md";
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

function StatusBadge({ status }) {
  if (status === "active")
    return <span className="badge badge-success text-xs">Active</span>;
  if (status === "expired")
    return <span className="badge badge-warning text-xs">Expired</span>;
  return <span className="badge badge-error text-xs">Revoked</span>;
}

function RevealPopup({ open, label, tokenValue, onClose }) {
  async function copyValue() {
    try {
      await navigator.clipboard.writeText(tokenValue);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable — copy the token manually");
    }
  }

  return (
    <Popup
      open={open}
      modal
      closeOnDocumentClick
      onClose={onClose}
      overlayStyle={{
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(3px)",
      }}
      contentStyle={{
        maxWidth: "560px",
        width: "92vw",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div className="bg-white">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-900 text-sm">Token Created</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 rounded"
            aria-label="Close"
          >
            <MdClose size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              ⚠️ {label}
            </p>
            <p className="text-xs text-amber-800 mt-2">
              Copy this token now. It will never be shown again.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900 mb-2">
              Token Value
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 block bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-green-400 break-all">
                {tokenValue}
              </code>
              <button
                type="button"
                onClick={copyValue}
                className="flex-shrink-0 btn-secondary p-2"
                title="Copy token"
              >
                <MdContentCopy size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            className="btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </Popup>
  );
}

function RotateTokenDialog({ open, tokenName, mode, input, onInputChange, onBack, onGenerateRandom, onConfirmCustom, loading, onClose }) {
  const [error, setError] = useState(null);

  const handleConfirmClick = () => {
    setError(null);
    const trimmed = input.trim();
    if (!trimmed) {
      setError("Token cannot be empty");
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      setError("Token must be a hexadecimal string (0-9, a-f)");
      return;
    }
    if (trimmed.length < 64) {
      setError("Token must be at least 64 hexadecimal characters (32 bytes)");
      return;
    }
    onConfirmCustom(trimmed);
  };

  return (
    <Popup
      open={open}
      modal
      closeOnDocumentClick={false}
      onClose={onClose}
      overlayStyle={{
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(3px)",
      }}
      contentStyle={{
        maxWidth: "560px",
        width: "92vw",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div className="bg-white">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-900 text-sm">Rotate Token: {tokenName}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 rounded"
            aria-label="Close"
            disabled={loading}
          >
            <MdClose size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {mode === "choice" && (
            <>
              <p className="text-sm text-slate-600">
                Choose how to generate a new token for <span className="font-mono font-semibold">{tokenName}</span>:
              </p>
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={onGenerateRandom}
                  disabled={loading}
                  className="w-full btn-primary text-left py-3"
                >
                  <div className="font-semibold">Generate Random Token</div>
                  <div className="text-xs text-slate-200 mt-1">Backend generates a secure random token</div>
                </button>
                <button
                  type="button"
                  onClick={onBack}
                  disabled={loading}
                  className="w-full btn-secondary text-left py-3"
                >
                  <div className="font-semibold">Type/Paste Token</div>
                  <div className="text-xs text-slate-500 mt-1">Provide your own hex token value (64+ chars)</div>
                </button>
              </div>
            </>
          )}

          {mode === "input" && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-900 mb-2">
                  Token Value (Hexadecimal)
                </label>
                <textarea
                  value={input}
                  onChange={(e) => {
                    setError(null);
                    onInputChange(e.target.value);
                  }}
                  placeholder="Enter a 64+ character hexadecimal token (0-9, a-f)"
                  className="w-full h-24 input-field font-mono text-xs"
                />
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
                <p className="mt-2 text-xs text-slate-500">
                  Token must be hexadecimal (0-9, a-f) and at least 64 characters
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2">
          {mode === "input" && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setError(null);
                onBack();
              }}
              disabled={loading}
            >
              Back
            </button>
          )}
          {mode === "input" && (
            <button
              type="button"
              className="btn-primary"
              onClick={handleConfirmClick}
              disabled={loading}
            >
              {loading ? "Confirming..." : "Confirm"}
            </button>
          )}
        </div>
      </div>
    </Popup>
  );
}

export default function Settings({
  tokenName,
  role,
  token,
  onLogout,
  onMenuClick,
}) {
  const [tokens, setTokens] = useState([]);
  const [tokensLoading, setTokensLoading] = useState(false);

  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenRole, setNewTokenRole] = useState("read");
  const [newTokenExpiry, setNewTokenExpiry] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealedToken, setRevealedToken] = useState(null); // { label, token }

  // Rotate dialog state
  const [rotateTarget, setRotateTarget] = useState(null); // null or token name
  const [rotateMode, setRotateMode] = useState(null); // null | "choice" | "input"
  const [rotateInput, setRotateInput] = useState(""); // user's custom token input
  const [rotatingToken, setRotatingToken] = useState(false);

  async function loadTokens() {
    setTokensLoading(true);
    try {
      const payload = await listTokens(token);
      setTokens(payload.tokens || []);
    } catch (error) {
      toast.error(`Failed to load tokens: ${error.message}`);
    } finally {
      setTokensLoading(false);
    }
  }

  useEffect(() => {
    if (role === "write") loadTokens();
  }, [token, role]);

  async function handleCreate(event) {
    event.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      toast.error("Token name is required");
      return;
    }
    setCreating(true);
    try {
      const payload = await createToken(
        token,
        name,
        newTokenRole,
        newTokenExpiry ? Number(newTokenExpiry) : undefined,
      );
      toast.success(`Token "${payload.name}" created`);
      setRevealedToken({ label: `Token "${payload.name}" created`, token: payload.token });
      setNewTokenName("");
      setNewTokenRole("read");
      setNewTokenExpiry("");
      await loadTokens();
    } catch (error) {
      toast.error(`Create failed: ${error.message}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(name) {
    if (!window.confirm(`Revoke token "${name}"? This cannot be undone.`)) return;
    try {
      await revokeToken(token, name);
      toast.success(`Token "${name}" revoked`);
      await loadTokens();
    } catch (error) {
      toast.error(`Revoke failed: ${error.message}`);
    }
  }

  function handleRotate(name) {
    setRotateTarget(name);
    setRotateMode("choice");
    setRotateInput("");
  }

  async function handleRotateConfirm(customToken) {
    if (!rotateTarget) return;
    setRotatingToken(true);
    try {
      const payload = await rotateToken(token, rotateTarget, customToken || undefined);
      toast.success(`Token "${rotateTarget}" rotated`);
      setRevealedToken({ label: `Token "${rotateTarget}" rotated`, token: payload.token });
      setRotateTarget(null);
      setRotateMode(null);
      setRotateInput("");
      await loadTokens();
    } catch (error) {
      toast.error(`Rotate failed: ${error.message}`);
    } finally {
      setRotatingToken(false);
    }
  }

  function validateTokenInput(input) {
    const trimmed = input.trim();
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      return "Token must be a hexadecimal string (0-9, a-f)";
    }
    if (trimmed.length < 64) {
      return "Token must be at least 64 hexadecimal characters (32 bytes)";
    }
    return null;
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
      toast.success("Exported as .env");
    } catch (error) {
      toast.error(`Export failed: ${error.message}`);
    }
  }

  const activeWriteCount = tokens.filter(
    (t) => t.role === "write" && tokenStatus(t) === "active",
  ).length;

  return (
    <div className="w-full">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Page title */}
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuClick}
            className="lg:hidden text-slate-600 hover:text-slate-900"
          >
            <MdMenu size={24} />
          </button>
          <div className="flex-1">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">Settings</h2>
            <p className="text-sm sm:text-base text-slate-600 hidden sm:block">
              Manage your preferences and account settings
            </p>
          </div>
        </div>

        {/* Revealed token popup */}
        {revealedToken && (
          <RevealPopup
            open={true}
            label={revealedToken.label}
            tokenValue={revealedToken.token}
            onClose={() => setRevealedToken(null)}
          />
        )}

        {/* Rotate token dialog */}
        <RotateTokenDialog
          open={rotateTarget !== null}
          tokenName={rotateTarget || ""}
          mode={rotateMode}
          input={rotateInput}
          onInputChange={setRotateInput}
          onBack={() => {
            setRotateMode("choice");
            setRotateInput("");
          }}
          onGenerateRandom={() => handleRotateConfirm(null)}
          onConfirmCustom={handleRotateConfirm}
          loading={rotatingToken}
          onClose={() => {
            setRotateTarget(null);
            setRotateMode(null);
            setRotateInput("");
          }}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* User Profile */}
          <div className="stat-card">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">User Profile</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-900 mb-2">
                  Token Name
                </label>
                <input
                  type="text"
                  value={tokenName}
                  readOnly
                  className="input-field bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-900 mb-2">
                  Role
                </label>
                <input
                  type="text"
                  value={role}
                  readOnly
                  className="input-field bg-slate-50 capitalize"
                />
              </div>
            </div>
          </div>

          {/* Security */}
          <div className="stat-card">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Security</h3>
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm text-blue-900 font-medium mb-2">🔒 Session Timeout</p>
                <p className="text-sm text-blue-800">
                  Your session expires after 5 minutes of inactivity for security.
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() =>
                  toast("Session timeout settings can be configured by your admin", { icon: "i" })
                }
              >
                Configure Session Timeout
              </button>
            </div>
          </div>

          {/* Export — write token only */}
          {role === "write" && (
            <div className="stat-card">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Export</h3>
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  Export your secrets to a secure format (.env file). Requires write token.
                </p>
                <button type="button" className="btn-primary w-full" onClick={handleExport}>
                  Export as .env
                </button>
              </div>
            </div>
          )}

          {/* Danger Zone */}
          <div className="stat-card border-red-200 bg-red-50">
            <h3 className="text-lg font-semibold text-red-900 mb-4">Danger Zone</h3>
            <div className="space-y-3">
              <p className="text-sm text-red-800">These actions cannot be undone.</p>
              <button
                type="button"
                className="btn-danger w-full"
                onClick={onLogout}
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        {/* Access Tokens — write token only */}
        {role === "write" && (
          <div className="stat-card space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Access Tokens</h3>
                <p className="text-sm text-slate-600 mt-1">
                  Create and manage read/write tokens for this vault.
                </p>
              </div>
              <button
                type="button"
                onClick={loadTokens}
                disabled={tokensLoading}
                className="btn-secondary p-2"
                title="Refresh token list"
              >
                <MdRefresh size={18} />
              </button>
            </div>

            {/* Create token form */}
            <form onSubmit={handleCreate} className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-4">
              <h4 className="text-sm font-semibold text-slate-900">Create New Token</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. ci-reader"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    className="input-field text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Role
                  </label>
                  <select
                    value={newTokenRole}
                    onChange={(e) => setNewTokenRole(e.target.value)}
                    className="input-field text-sm"
                  >
                    <option value="read">Read</option>
                    <option value="write">Write</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Expires
                  </label>
                  <select
                    value={newTokenExpiry}
                    onChange={(e) => setNewTokenExpiry(e.target.value)}
                    className="input-field text-sm"
                  >
                    {EXPIRY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <button
                type="submit"
                className="btn-primary text-sm"
                disabled={creating}
              >
                {creating ? "Creating..." : "Create Token"}
              </button>
            </form>

            {/* Token list */}
            {tokensLoading && tokens.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">Loading tokens...</p>
            ) : tokens.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-4">No tokens found.</p>
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-3 px-3 font-semibold text-slate-900">Name</th>
                      <th className="text-left py-3 px-3 font-semibold text-slate-900">Role</th>
                      <th className="text-left py-3 px-3 font-semibold text-slate-900 hidden sm:table-cell">Created</th>
                      <th className="text-left py-3 px-3 font-semibold text-slate-900 hidden md:table-cell">Expires</th>
                      <th className="text-left py-3 px-3 font-semibold text-slate-900">Status</th>
                      <th className="text-right py-3 px-3 font-semibold text-slate-900">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((t) => {
                      const status = tokenStatus(t);
                      const isLastActiveWrite =
                        t.role === "write" && status === "active" && activeWriteCount <= 1;
                      return (
                        <tr key={t.name} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="py-3 px-3 font-mono text-slate-800 max-w-[120px] truncate">
                            {t.name}
                          </td>
                          <td className="py-3 px-3 capitalize text-slate-700">{t.role}</td>
                          <td className="py-3 px-3 text-slate-500 hidden sm:table-cell whitespace-nowrap">
                            {new Date(t.created_at).toLocaleDateString()}
                          </td>
                          <td className="py-3 px-3 text-slate-500 hidden md:table-cell whitespace-nowrap">
                            {t.expires_at
                              ? new Date(t.expires_at).toLocaleDateString()
                              : "Never"}
                          </td>
                          <td className="py-3 px-3">
                            <StatusBadge status={status} />
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex gap-2 justify-end">
                              {status === "active" && (
                                <button
                                  type="button"
                                  className="btn-secondary text-xs py-1 px-2"
                                  onClick={() => handleRotate(t.name)}
                                  title="Rotate — generates a new token value"
                                >
                                  Rotate
                                </button>
                              )}
                              {status === "active" && (
                                <button
                                  type="button"
                                  className="btn-danger text-xs py-1 px-2"
                                  onClick={() => handleRevoke(t.name)}
                                  disabled={isLastActiveWrite}
                                  title={
                                    isLastActiveWrite
                                      ? "Cannot revoke the last active write token"
                                      : "Revoke token"
                                  }
                                >
                                  Revoke
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
