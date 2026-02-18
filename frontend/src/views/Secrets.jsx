import { MdDelete, MdMenu } from "react-icons/md";
import SecretCard from "../components/SecretCard.jsx";

function maskSecret(value, start = 3, end = 2) {
  if (!value) return "";
  if (value.length <= start + end) return "*".repeat(value.length);
  return `${value.slice(0, start)}${"*".repeat(Math.max(8, value.length - start - end))}${value.slice(-end)}`;
}

export default function Secrets({
  keys,
  keyFolders,
  folders,
  filteredKeys,
  defaultFolderName,
  defaultFolderDraft,
  setDefaultFolderDraft,
  newFolderName,
  setNewFolderName,
  secretCache,
  secretMeta,
  role,
  busy,
  loading,
  authToken,
  onCopy,
  onDelete,
  onRenameDefaultFolder,
  onAddFolder,
  onDeleteFolder,
  onMenuClick,
}) {
  const groupedFolders = folders.map((folderName) => {
    const allKeysInFolder = keys.filter(
      (keyName) => (keyFolders[keyName] || defaultFolderName) === folderName,
    );
    const visibleKeysInFolder = filteredKeys.filter(
      (keyName) => (keyFolders[keyName] || defaultFolderName) === folderName,
    );
    return {
      name: folderName,
      totalCount: allKeysInFolder.length,
      visibleKeys: visibleKeysInFolder,
    };
  });

  const orphanedTotal = keys.filter((keyName) => {
    const folderName = keyFolders[keyName] || defaultFolderName;
    return !folders.includes(folderName);
  }).length;
  const orphanedVisible = filteredKeys.filter((keyName) => {
    const folderName = keyFolders[keyName] || defaultFolderName;
    return !folders.includes(folderName);
  });

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="lg:hidden text-slate-600 hover:text-slate-900"
        >
          <MdMenu size={24} />
        </button>
        <div>
          <h2 className="text-xl font-bold text-slate-900">All Secrets</h2>
          <p className="text-sm text-slate-600">Browse secrets grouped by folder and manage folder assignments.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <aside className="xl:col-span-4">
          <div className="stat-card space-y-4 xl:sticky xl:top-6">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Folder Management</h3>
              <p className="text-sm text-slate-600 mt-1">Create and remove folders used by your secrets.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900 mb-2">
                Default Folder Name
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={defaultFolderDraft}
                  onChange={(event) => setDefaultFolderDraft(event.target.value)}
                  className="input-field flex-1"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={onRenameDefaultFolder}
                  disabled={loading}
                >
                  Save
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900 mb-2">
                Add New Folder
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Folder name..."
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onAddFolder();
                    }
                  }}
                  className="input-field flex-1"
                />
                <button type="button" className="btn-primary" onClick={onAddFolder}>
                  Add
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-900 mb-2">
                Existing Folders
              </label>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {groupedFolders.map((folder) => (
                  <div
                    key={folder.name}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg"
                  >
                    <div>
                      <p className="text-slate-900 font-medium">{folder.name}</p>
                      <p className="text-xs text-slate-500">{folder.totalCount} secret(s)</p>
                    </div>
                    {folder.name !== defaultFolderName && (
                      <button
                        type="button"
                        className="p-2 rounded text-red-600 hover:bg-red-100"
                        onClick={() => onDeleteFolder(folder.name)}
                        aria-label={`Delete folder ${folder.name}`}
                        title="Delete folder"
                      >
                        <MdDelete size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {orphanedTotal > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-sm font-medium text-amber-900">Unassigned Secrets</p>
                <p className="text-xs text-amber-800 mt-1">
                  {orphanedTotal} secret(s) still reference deleted folders.
                </p>
              </div>
            )}
          </div>
        </aside>

        <section className="xl:col-span-8 space-y-6">
          {groupedFolders.map((folder) => (
            <div key={folder.name} className="stat-card">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-slate-900">{folder.name}</h3>
                <p className="text-sm text-slate-600">
                  {folder.name === defaultFolderName
                    ? "Default folder for secrets without a custom folder."
                    : `Secrets currently assigned to ${folder.name}.`}
                </p>
              </div>

              {folder.visibleKeys.length === 0 ? (
                <p className="text-sm text-slate-500">No secrets in this folder</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {folder.visibleKeys.map((keyName) => (
                    <SecretCard
                      key={keyName}
                      keyName={keyName}
                      folder={folder.name}
                      authToken={authToken}
                      preview={secretCache[keyName] ? maskSecret(secretCache[keyName]) : ""}
                      createdAt={secretMeta[keyName]?.createdAt}
                      role={role}
                      busy={busy}
                      onCopy={onCopy}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {orphanedTotal > 0 && (
            <div className="stat-card border-amber-200 bg-amber-50/40">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-amber-900">Unassigned</h3>
                <p className="text-sm text-amber-800">
                  These secrets are linked to folders that no longer exist in your folder list.
                </p>
              </div>

              {orphanedVisible.length === 0 ? (
                <p className="text-sm text-amber-800">No secrets in this folder</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {orphanedVisible.map((keyName) => (
                    <SecretCard
                      key={keyName}
                      keyName={keyName}
                      folder={keyFolders[keyName] || defaultFolderName}
                      authToken={authToken}
                      preview={secretCache[keyName] ? maskSecret(secretCache[keyName]) : ""}
                      createdAt={secretMeta[keyName]?.createdAt}
                      role={role}
                      busy={busy}
                      onCopy={onCopy}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
