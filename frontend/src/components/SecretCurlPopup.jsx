import { useEffect, useState } from "react";
import Popup from "reactjs-popup";
import { MdContentCopy, MdClose } from "react-icons/md";
import { toast } from "react-hot-toast";
import { listTokens } from "../api.js";

function buildCurl(baseUrl, folder, keyName, tokenValue) {
  return `curl -s -H "Authorization: Bearer ${tokenValue}" "${baseUrl}/api/secrets/${encodeURIComponent(folder)}/${encodeURIComponent(keyName)}" | jq -r '.value'`;
}

function isActiveReadToken(t) {
  if (t.role !== "read") return false;
  if (t.revoked_at) return false;
  if (t.expires_at && new Date() > new Date(t.expires_at)) return false;
  return true;
}

export default function SecretCurlPopup({ open, onClose, keyName, folder, authToken }) {
  const [readTokens, setReadTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedTokenName, setSelectedTokenName] = useState("");

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    listTokens(authToken)
      .then((payload) => {
        const active = (payload.tokens || [])
          .filter(isActiveReadToken)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); // oldest first
        setReadTokens(active);
        setSelectedTokenName(active.length > 0 ? active[0].name : "");
      })
      .catch((err) => {
        toast.error(`Failed to load tokens: ${err.message}`);
        setReadTokens([]);
      })
      .finally(() => setLoading(false));
  }, [open, authToken]);

  const baseUrl = window.location.origin;
  const selected = readTokens.find((t) => t.name === selectedTokenName);

  // Token value is the token name — we don't store raw values after creation.
  // The curl command uses a placeholder if no raw value: user replaces <TOKEN>.
  // Since we only have the token name (not raw), the curl template uses $TOKEN_NAME as a shell var hint.
  const curlCmd = selected
    ? `curl -s -H "Authorization: Bearer $${selected.name.toUpperCase().replace(/-/g, "_")}" "${baseUrl}/api/secrets/${encodeURIComponent(folder)}/${encodeURIComponent(keyName)}" | jq -r '.value'`
    : `curl -s -H "Authorization: Bearer <READ_TOKEN>" "${baseUrl}/api/secrets/${encodeURIComponent(folder)}/${encodeURIComponent(keyName)}" | jq -r '.value'`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(curlCmd);
      toast.success("curl command copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable — copy the command manually");
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
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-100 text-green-700 flex items-center justify-center font-bold text-sm flex-shrink-0">
              {keyName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 text-sm">{keyName}</h3>
              <p className="text-xs text-slate-500">{folder}</p>
            </div>
          </div>
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
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              Read Token
            </label>
            {loading ? (
              <div className="input-field bg-slate-50 text-slate-400 text-sm">
                Loading tokens…
              </div>
            ) : readTokens.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                No active read tokens found. Create one in Settings → Access Tokens.
              </div>
            ) : (
              <select
                value={selectedTokenName}
                onChange={(e) => setSelectedTokenName(e.target.value)}
                className="input-field text-sm"
              >
                {readTokens.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}{t.expires_at ? ` (expires ${new Date(t.expires_at).toLocaleDateString()})` : ""}
                  </option>
                ))}
              </select>
            )}
            {selected && (
              <p className="text-xs text-slate-500 mt-1">
                The command uses{" "}
                <code className="font-mono bg-slate-100 px-1 rounded">
                  ${selected.name.toUpperCase().replace(/-/g, "_")}
                </code>{" "}
                as a shell variable — set it to the token's raw value before running.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              curl Command
            </label>
            <div className="relative">
              <pre className="bg-slate-900 text-green-400 rounded-lg px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                {curlCmd}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="btn-primary flex items-center gap-2"
            onClick={handleCopy}
            disabled={loading}
          >
            <MdContentCopy size={16} />
            Copy Command
          </button>
        </div>
      </div>
    </Popup>
  );
}
