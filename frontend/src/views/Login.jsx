import { toast } from "react-hot-toast";

export default function Login({
  tokenInput,
  setTokenInput,
  tokenVisible,
  setTokenVisible,
  rememberLogin,
  setRememberLogin,
  onSubmit,
  loading,
}) {
  return (
    <div className="min-h-screen bg-gradient flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg p-8">
          <div className="w-12 h-12 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-xl mx-auto mb-6">
            S
          </div>
          <h1 className="text-2xl font-bold text-slate-900 text-center mb-2">
            Secrets Manager
          </h1>
          <p className="text-center text-slate-600 mb-8">
            Log in to access your secure vault
          </p>

          <form className="space-y-4" onSubmit={onSubmit} autoComplete="off">
            <div>
              <label htmlFor="token-input" className="block text-sm font-medium text-slate-900 mb-2">
                Security Token
              </label>
              <div className="flex gap-2">
                <input
                  id="token-input"
                  type={tokenVisible ? "text" : "password"}
                  placeholder="Paste your access token here..."
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  className="input-field flex-1"
                  required
                />
                <button
                  type="button"
                  onClick={() => setTokenVisible((current) => !current)}
                  className="btn-secondary"
                >
                  {tokenVisible ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberLogin}
                  onChange={(event) => setRememberLogin(event.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-700">Keep me logged in</span>
              </label>
            </div>

            <button className="btn-primary w-full" type="submit" disabled={loading}>
              Verify Identity
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-slate-200">
            <p className="text-center text-xs text-slate-500 mb-3">Need help?</p>
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() => toast("Use a valid read or write token", { icon: "i" })}
            >
              Help with Token
            </button>
          </div>

          <p className="text-center text-xs text-slate-500 mt-6">
            Protected by enterprise-grade encryption.
          </p>
        </div>
      </div>
    </div>
  );
}
