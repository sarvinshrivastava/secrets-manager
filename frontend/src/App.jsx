import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "react-hot-toast";
import {
  getMe,
  listSecrets,
  getFolders,
  getSecret,
  createSecret,
  bulkCreateSecrets,
  editSecret,
  deleteSecret,
  setUnauthorizedHandler,
} from "./api.js";
import { secretId } from "./lib/format.js";
import Login from "./views/Login.jsx";
import Vault from "./views/Vault.jsx";
import AuditList from "./views/AuditList.jsx";
import Analytics from "./views/Analytics.jsx";
import Settings from "./views/Settings.jsx";
import TopBar from "./components/TopBar.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import AddSingleDialog from "./components/AddSingleDialog.jsx";
import EditSecretDialog from "./components/EditSecretDialog.jsx";
import { useModalGuard } from "./hooks/useModalGuard.jsx";
import {
  applyTheme,
  nextThemePref,
  readThemePref,
  resolveTheme,
  subscribeSystemTheme,
  writeThemePref,
} from "./lib/theme.js";
import BulkAddSheet from "./components/BulkAddSheet.jsx";

const SESSION_TOKEN_KEY = "sm_token_session";
const PERSIST_TOKEN_KEY = "sm_token_persist";
const DEFAULT_FOLDER_KEY = "sm_default_folder";

function storeToken(token, remember) {
  if (remember) {
    localStorage.setItem(PERSIST_TOKEN_KEY, token);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    return;
  }
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  localStorage.removeItem(PERSIST_TOKEN_KEY);
}

function clearStoredToken() {
  localStorage.removeItem(PERSIST_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

export default function App() {
  const [token, setToken] = useState(
    () =>
      localStorage.getItem(PERSIST_TOKEN_KEY) ||
      sessionStorage.getItem(SESSION_TOKEN_KEY) ||
      "",
  );
  const [tokenInput, setTokenInput] = useState("");
  const [rememberLogin, setRememberLogin] = useState(() =>
    Boolean(localStorage.getItem(PERSIST_TOKEN_KEY)),
  );

  const [role, setRole] = useState("");
  const [tokenName, setTokenName] = useState("");

  // secrets: [{ key, folder, id }]. Composite folder+key identity — key alone
  // is not unique (backend UNIQUE(folder,key)).
  const [secrets, setSecrets] = useState([]);
  const [folders, setFolders] = useState([]);
  const [secretCache, setSecretCache] = useState({}); // id -> value
  const [secretMeta, setSecretMeta] = useState({}); // id -> { createdAt, folder }

  const [searchTerm, setSearchTerm] = useState("");
  const [folderFilter, setFolderFilter] = useState("All");
  const [view, setView] = useState("vault");

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [addSingleOpen, setAddSingleOpen] = useState(false);
  // Preset for the Add dialog ("+ Folder" opens it with the folder name field).
  const [addPreset, setAddPreset] = useState({ folder: "", mode: "select" });
  const [editTarget, setEditTarget] = useState(null); // secret or null
  // Bump to make Vault drop revealed plaintext for these ids.
  const [evicted, setEvicted] = useState({ n: 0, ids: [] });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // secret or null

  const [themePref, setThemePref] = useState(readThemePref);
  const [resolvedTheme, setResolvedTheme] = useState(() =>
    resolveTheme(readThemePref()),
  );
  const [defaultFolder, setDefaultFolder] = useState(
    () => localStorage.getItem(DEFAULT_FOLDER_KEY) || "Root",
  );

  const signedIn = useMemo(() => Boolean(token && role), [token, role]);

  // Apply + persist the theme preference. In "auto" the browser's colour scheme
  // is followed live; the listener exists only while the preference is auto.
  useEffect(() => {
    writeThemePref(themePref);
    const sync = () => {
      const resolved = resolveTheme(themePref);
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    sync();
    if (themePref !== "auto") return undefined;
    return subscribeSystemTheme(sync);
  }, [themePref]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_FOLDER_KEY, defaultFolder);
  }, [defaultFolder]);

  function resetState() {
    setRole("");
    setTokenName("");
    setSecrets([]);
    setFolders([]);
    setSecretCache({});
    setSecretMeta({});
    setSearchTerm("");
    setFolderFilter("All");
    setView("vault");
    setAddSingleOpen(false);
    setBulkOpen(false);
    setEditTarget(null);
    setDeleteTarget(null);
  }

  const logout = useCallback((message) => {
    clearStoredToken();
    setToken("");
    resetState();
    if (message) toast(message, { icon: "!" });
  }, []);

  // api.js calls this once on any 401 — clear the token, no toast storm.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearStoredToken();
      setToken("");
      resetState();
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const refreshSecrets = useCallback(
    async (activeToken = token) => {
      const [secretsPayload, foldersPayload] = await Promise.all([
        listSecrets(activeToken),
        getFolders(activeToken).catch(() => ({ folders: [] })),
      ]);

      const rawKeys = secretsPayload.keys || [];
      const nextSecrets = rawKeys.map((item) => {
        const key = typeof item === "string" ? item : item.key;
        const folder =
          typeof item === "string" ? "Root" : item.folder || "Root";
        return { key, folder, id: secretId(folder, key) };
      });
      setSecrets(nextSecrets);

      // Folders from the server; union with folders actually in use so nothing
      // is orphaned in the chip bar.
      const serverFolders = Array.isArray(foldersPayload.folders)
        ? foldersPayload.folders
        : [];
      const used = nextSecrets.map((s) => s.folder);
      const nextFolders = [...new Set([...serverFolders, ...used])].sort();
      setFolders(nextFolders);
      // The filtered folder can vanish (last secret moved/deleted): fall back.
      setFolderFilter((current) =>
        current === "All" || nextFolders.includes(current) ? current : "All",
      );
    },
    [token],
  );

  const validateAndLoad = useCallback(
    async (activeToken) => {
      const me = await getMe(activeToken);
      setRole(me.role);
      setTokenName(me.token_name);
      await refreshSecrets(activeToken);
    },
    [refreshSecrets],
  );

  useEffect(() => {
    if (!token) {
      setLoading(false);
      resetState();
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    validateAndLoad(token)
      .catch((error) => {
        if (cancelled) return;
        if (error.message !== "Unauthorized") {
          toast.error(`Sign-in failed: ${error.message}`);
        }
        logout();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Load a secret value by composite id; caches value + meta. Resolves the
  // right folder's secret even when the same key exists elsewhere.
  const loadSecret = useCallback(
    async (id) => {
      if (secretCache[id] !== undefined) return secretCache[id];
      const secret = secrets.find((s) => s.id === id);
      if (!secret) throw new Error("Secret not found");
      const payload = await getSecret(token, secret.folder, secret.key);
      setSecretCache((current) => ({ ...current, [id]: payload.value }));
      setSecretMeta((current) => ({
        ...current,
        [id]: {
          createdAt: payload.created_at,
          folder: payload.folder || secret.folder,
        },
      }));
      return payload.value;
    },
    [secretCache, secrets, token],
  );

  const handleCopy = useCallback(
    async (id) => {
      setBusy(true);
      try {
        const value = await loadSecret(id);
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard unavailable in this browser");
        }
        await navigator.clipboard.writeText(value);
        toast.success("Copied to clipboard");
      } catch (error) {
        if (error.message !== "Unauthorized")
          toast.error(`Copy failed: ${error.message}`);
      } finally {
        setBusy(false);
      }
    },
    [loadSecret],
  );

  function handleLogin(event) {
    event.preventDefault();
    const next = tokenInput.trim();
    if (!next) {
      toast.error("Access token is required");
      return;
    }
    resetState();
    storeToken(next, rememberLogin);
    setToken(next);
    setTokenInput("");
  }

  async function handleAddSingle({ key, value, folder }) {
    setBusy(true);
    try {
      await createSecret(token, key, value, folder);
      await refreshSecrets(token);
      setAddSingleOpen(false);
      toast.success(`Added ${key}`);
    } catch (error) {
      if (error.message !== "Unauthorized")
        toast.error(`Save failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function evictSecretData(ids) {
    setSecretCache((current) => {
      const next = { ...current };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    setSecretMeta((current) => {
      const next = { ...current };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    setEvicted((current) => ({ n: current.n + 1, ids }));
  }

  function openAdd(preset = { folder: "", mode: "select" }) {
    setAddPreset(preset);
    setAddSingleOpen(true);
  }

  // Fresh read for the edit dialog: never served from secretCache (another
  // client may have changed it), never written to it (plaintext stays in the
  // dialog only).
  const loadFreshValue = useCallback(
    async (secret) => {
      const payload = await getSecret(token, secret.folder, secret.key);
      return payload.value;
    },
    [token],
  );

  // Returns an error message for the dialog to show inline, or null on success.
  async function handleEditSecret(patch) {
    const target = editTarget;
    if (!target) return null;
    setBusy(true);
    let result;
    try {
      result = await editSecret(token, target.folder, target.key, patch);
    } catch (error) {
      setBusy(false);
      if (error.message === "Unauthorized") return null;
      // The secret vanished (e.g. a retried edit already applied): resync.
      if (error.message === "Secret not found") {
        refreshSecrets(token).catch(() => {});
      }
      return error.message;
    }
    const newKey = result?.key ?? patch.key ?? target.key;
    const newFolder = result?.folder ?? patch.folder ?? target.folder;
    evictSecretData([target.id, secretId(newFolder, newKey)]);
    setEditTarget(null);
    toast.success(`Saved ${newKey}`);
    // The edit is committed; a failed refresh must never read as "Save failed".
    try {
      await refreshSecrets(token);
    } catch (error) {
      if (error.message !== "Unauthorized") {
        toast("Saved — couldn't refresh the list, reload to see it", {
          icon: "!",
        });
      }
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function handleBulkCommit({ folder, secrets: rows, overwrite }) {
    setBusy(true);
    try {
      const result = await bulkCreateSecrets(token, folder, rows, overwrite);

      // Overwritten (and newly added) keys keep the same composite id, so their
      // stale plaintext would survive in the caches and be revealed/copied next
      // time. Evict them the same way confirmDelete does.
      const evictIds = [...(result.updated || []), ...(result.added || [])].map(
        (k) => secretId(folder, k),
      );
      if (evictIds.length > 0) evictSecretData(evictIds);

      await refreshSecrets(token);
      setBulkOpen(false);
      const added = result.added?.length ?? 0;
      const updated = result.updated?.length ?? 0;
      const skipped = result.skipped?.length ?? 0;
      const invalid = result.invalid?.length ?? 0;
      toast.success(
        `Added ${added} · updated ${updated} · skipped ${skipped} · invalid ${invalid}`,
      );
    } catch (error) {
      if (error.message !== "Unauthorized")
        toast.error(`Bulk add failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteSecret(token, deleteTarget.folder, deleteTarget.key);
      evictSecretData([deleteTarget.id]);
      await refreshSecrets(token);
      setDeleteTarget(null);
      toast.success("Deleted");
    } catch (error) {
      if (error.message !== "Unauthorized")
        toast.error(`Delete failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Back closes the delete confirm instead of leaving the site (never dirty).
  const deleteGuard = useModalGuard({
    open: Boolean(deleteTarget),
    onClose: () => setDeleteTarget(null),
    escape: false, // ConfirmDialog handles its own Escape
  });

  if (!signedIn) {
    return (
      <>
        <Login
          tokenInput={tokenInput}
          setTokenInput={setTokenInput}
          rememberLogin={rememberLogin}
          setRememberLogin={setRememberLogin}
          onSubmit={handleLogin}
          loading={loading}
        />
        <Toaster
          position="bottom-center"
          toastOptions={{ className: "sm-toast", duration: 3500 }}
        />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <TopBar
        view={view}
        onViewChange={setView}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        role={role}
        themePref={themePref}
        resolvedTheme={resolvedTheme}
        onCycleTheme={() => setThemePref((p) => nextThemePref(p))}
        onAddSingle={() => openAdd()}
        onAddBulk={() => setBulkOpen(true)}
        dialogOpen={
          addSingleOpen ||
          bulkOpen ||
          Boolean(editTarget) ||
          Boolean(deleteTarget)
        }
      />

      <main className="mx-auto max-w-6xl px-4 py-5">
        {view === "vault" && (
          <Vault
            secrets={secrets}
            folders={folders}
            meta={secretMeta}
            role={role}
            busy={busy}
            searchTerm={searchTerm}
            folderFilter={folderFilter}
            onFolderFilter={setFolderFilter}
            onCopy={handleCopy}
            onEdit={setEditTarget}
            onDelete={setDeleteTarget}
            onAddFolder={() => openAdd({ folder: "", mode: "new" })}
            evicted={evicted}
            loadSecret={loadSecret}
          />
        )}
        {view === "audit" && <AuditList token={token} />}
        {view === "analytics" && <Analytics token={token} />}
        {view === "settings" && (
          <Settings
            tokenName={tokenName}
            role={role}
            token={token}
            folders={folders}
            defaultFolder={defaultFolder}
            onDefaultFolderChange={setDefaultFolder}
            onLogout={() => logout("Signed out")}
          />
        )}
      </main>

      {role === "write" && (
        <>
          <AddSingleDialog
            open={addSingleOpen}
            folders={folders}
            defaultFolder={defaultFolder}
            initialFolder={addPreset.folder}
            initialFolderMode={addPreset.mode}
            busy={busy}
            onSubmit={handleAddSingle}
            onClose={() => setAddSingleOpen(false)}
          />
          <EditSecretDialog
            open={Boolean(editTarget)}
            secret={editTarget}
            folders={folders}
            busy={busy}
            onLoadValue={loadFreshValue}
            onSubmit={handleEditSecret}
            onClose={() => setEditTarget(null)}
          />
          <BulkAddSheet
            open={bulkOpen}
            folders={folders}
            defaultFolder={defaultFolder}
            secrets={secrets}
            busy={busy}
            onCommit={handleBulkCommit}
            onClose={() => setBulkOpen(false)}
          />
        </>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete secret?"
        body="This permanently removes the secret from the vault."
        mono={
          deleteTarget ? `${deleteTarget.folder} / ${deleteTarget.key}` : ""
        }
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={confirmDelete}
        onClose={deleteGuard.requestClose}
      />

      <Toaster
        position="bottom-center"
        toastOptions={{ className: "sm-toast", duration: 3500 }}
      />
    </div>
  );
}
