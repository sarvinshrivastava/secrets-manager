import { useState } from "react";
import { MdDelete, MdContentCopy } from "react-icons/md";
import SecretCurlPopup from "./SecretCurlPopup.jsx";

function inferLabel(keyName) {
  const key = keyName.toLowerCase();
  if (key.includes("api") || key.includes("token")) return "API Key";
  if (key.includes("password") || key.includes("pass")) return "Password";
  if (key.includes("url") || key.includes("host")) return "Config";
  if (key.includes("aws")) return "Cloud";
  return "Secret";
}

function inferDescription(keyName) {
  const label = inferLabel(keyName);
  if (label === "Cloud") return "Cloud credentials";
  if (label === "Password") return "Protected credential";
  if (label === "Config") return "Environment configuration";
  return "Service credential";
}

function relativeTime(timestamp) {
  if (!timestamp) return "just now";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "recently";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function SecretCard({
  keyName,
  folder,
  preview,
  createdAt,
  role,
  busy,
  authToken,
  onCopy,
  onDelete,
}) {
  const [popupOpen, setPopupOpen] = useState(false);

  return (
    <>
      <div
        className="secret-card group cursor-pointer"
        onClick={() => setPopupOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setPopupOpen(true);
        }}
        aria-label={`Open curl command for ${keyName}`}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-green-100 text-green-700 flex items-center justify-center font-bold">
            {keyName.slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-slate-900 truncate">{keyName}</h3>
            <p className="text-sm text-slate-500">{inferDescription(keyName)}</p>
          </div>
          {role === "write" && (
            <button
              type="button"
              className="flex-shrink-0 p-1.5 rounded-md text-red-500 hover:bg-red-50 hover:scale-110 transition-transform"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(keyName);
              }}
              aria-label={`Delete ${keyName}`}
              title="Delete"
              disabled={busy}
            >
              <MdDelete size={18} />
            </button>
          )}
        </div>

        <div className="mb-3 p-2 bg-slate-100 rounded font-mono text-sm text-slate-700 truncate">
          {preview || "••••••••••••••••"}
        </div>

        <div className="flex items-center justify-between mb-3">
          <small className="text-slate-500">Created {relativeTime(createdAt)}</small>
          <span className="badge badge-success text-xs">{inferLabel(keyName)}</span>
        </div>

        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            className="p-2 rounded bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            onClick={(event) => {
              event.stopPropagation();
              onCopy(keyName);
            }}
            aria-label={`Copy ${keyName}`}
            title="Copy secret value"
            disabled={busy}
          >
            <MdContentCopy size={16} />
          </button>
        </div>
      </div>

      <SecretCurlPopup
        open={popupOpen}
        onClose={() => setPopupOpen(false)}
        keyName={keyName}
        folder={folder}
        authToken={authToken}
      />
    </>
  );
}
