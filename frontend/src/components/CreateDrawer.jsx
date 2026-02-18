import Popup from "reactjs-popup";
import { toast } from "react-hot-toast";

export default function CreateDrawer({
  open,
  onClose,
  draft,
  onDraftChange,
  folders,
  onSubmit,
  loading,
}) {
  return (
    <Popup
      open={open}
      modal
      closeOnDocumentClick
      onClose={onClose}
      overlayStyle={{
        background: "rgba(15, 23, 42, 0.34)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "flex-end",
      }}
      contentStyle={{
        margin: 0,
        width: "min(720px, 96vw)",
        border: "none",
        borderRadius: 0,
        padding: 0,
        height: "100vh",
        maxHeight: "100vh",
      }}
    >
      <form
        className="w-full bg-white flex flex-col h-full overflow-hidden"
        onSubmit={onSubmit}
        autoComplete="off"
      >
        <header className="sticky top-0 bg-white border-b border-slate-200 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Create New Secret</h2>
              <p className="text-sm text-slate-600 mt-1">Add a new secure value to your vault.</p>
            </div>
            <button
              type="button"
              className="text-slate-500 hover:text-slate-700"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6" style={{ maxHeight: "calc(100vh - 180px)" }}>
          <section>
            <h3 className="text-lg font-semibold text-slate-900 mb-4">General Information</h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="draft-name" className="block text-sm font-medium text-slate-900 mb-1">
                  Name
                </label>
                <input
                  id="draft-name"
                  type="text"
                  placeholder="PRODUCTION_DATABASE_KEY"
                  value={draft.key}
                  onChange={(event) => onDraftChange({ key: event.target.value })}
                  className="input-field"
                  required
                />
              </div>
              <div>
                <label htmlFor="draft-folder" className="block text-sm font-medium text-slate-900 mb-1">
                  Folder
                </label>
                <select
                  id="draft-folder"
                  value={draft.folder}
                  onChange={(event) => onDraftChange({ folder: event.target.value })}
                  className="input-field"
                >
                  {folders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="draft-description" className="block text-sm font-medium text-slate-900 mb-1">
                  Description
                </label>
                <textarea
                  id="draft-description"
                  placeholder="Describe what this secret is used for..."
                  value={draft.description}
                  onChange={(event) => onDraftChange({ description: event.target.value })}
                  rows={3}
                  className="input-field"
                />
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Secret Value</h3>
              <button
                type="button"
                className="text-sm text-green-600 hover:text-green-700 font-medium"
                onClick={() => {
                  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
                  onDraftChange({ value: random });
                  toast.success("Random value generated");
                }}
              >
                Generate Random
              </button>
            </div>
            <div>
              <label htmlFor="draft-value" className="block text-sm font-medium text-slate-900 mb-1">
                Value
              </label>
              <textarea
                id="draft-value"
                placeholder="Paste your private key, token, or secret string..."
                value={draft.value}
                onChange={(event) => onDraftChange({ value: event.target.value })}
                rows={5}
                className="input-field font-mono text-sm"
                required
              />
            </div>
          </section>
        </div>

        <footer className="sticky bottom-0 bg-white border-t border-slate-200 p-6 flex items-center justify-between">
          <small className="text-slate-600">Secret cannot be modified after creation.</small>
          <div className="flex gap-3">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              Create Secret
            </button>
          </div>
        </footer>
      </form>
    </Popup>
  );
}
