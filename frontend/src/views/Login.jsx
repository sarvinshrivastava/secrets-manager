import { useState } from "react";

export default function Login({
  tokenInput,
  setTokenInput,
  rememberLogin,
  setRememberLogin,
  onSubmit,
  loading,
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-md border border-line-strong bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-6 py-4">
          <span className="flex h-7 w-7 items-center justify-center border border-accent bg-accent font-mono text-xs font-bold text-surface">
            SM
          </span>
          <span className="font-mono text-sm font-semibold text-ink">
            secret·manager
          </span>
        </div>

        <form
          className="space-y-4 px-6 py-6"
          onSubmit={onSubmit}
          autoComplete="off"
        >
          <div>
            <label
              htmlFor="token-input"
              className="mb-1 block font-mono text-xs uppercase tracking-wide text-faint"
            >
              Access token
            </label>
            <div className="flex gap-2">
              <input
                id="token-input"
                type={visible ? "text" : "password"}
                placeholder="paste read or write token…"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                className="sm-input flex-1"
                required
              />
              <button
                type="button"
                onClick={() => setVisible((v) => !v)}
                className="sm-btn"
              >
                {visible ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 font-mono text-sm text-muted">
            <input
              type="checkbox"
              checked={rememberLogin}
              onChange={(event) => setRememberLogin(event.target.checked)}
            />
            Keep me signed in
          </label>

          <button
            type="submit"
            className="sm-btn-accent w-full"
            disabled={loading}
          >
            {loading ? "Verifying…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
