import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "react-hot-toast";
import {
  getMe,
  listSecrets,
  getFolders,
  getSecret,
  createSecret,
  bulkCreateSecrets,
  deleteSecret,
  setUnauthorizedHandler,
} from "./api.js";
import { secretId } from "./lib/format.js";
import Login from "./views/Login.jsx";
import Vault from "./views/Vault.jsx";
import AuditList from "./views/AuditList.jsx";
import Settings from "./views/Settings.jsx";
import TopBar from "./components/TopBar.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import AddSingleDialog from "./components/AddSingleDialog.jsx";
import BulkAddSheet from "./components/BulkAddSheet.jsx";

const SESSION_TOKEN_KEY = "sm_token_session";
const PERSIST_TOKEN_KEY = "sm_token_persist";
const DEFAULT_FOLDER_KEY = "sm_default_folder";
const THEME_KEY = "sm_theme";

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

function initialTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
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
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // secret or null

  const [theme, setTheme] = useState(initialTheme);
  const [defaultFolder, setDefaultFolder] = useState(
    () => localStorage.getItem(DEFAULT_FOLDER_KEY) || "Root",
  );

  const signedIn = useMemo(() => Boolean(token && role), [token, role]);

  // Apply + persist theme.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

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
      setFolders([...new Set([...serverFolders, ...used])].sort());
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
      if (evictIds.length > 0) {
        setSecretCache((current) => {
          const next = { ...current };
          evictIds.forEach((id) => delete next[id]);
          return next;
        });
        setSecretMeta((current) => {
          const next = { ...current };
          evictIds.forEach((id) => delete next[id]);
          return next;
        });
      }

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
      setSecretCache((current) => {
        const next = { ...current };
        delete next[deleteTarget.id];
        return next;
      });
      setSecretMeta((current) => {
        const next = { ...current };
        delete next[deleteTarget.id];
        return next;
      });
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
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onAddSingle={() => setAddSingleOpen(true)}
        onAddBulk={() => setBulkOpen(true)}
        dialogOpen={addSingleOpen || bulkOpen || Boolean(deleteTarget)}
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
            onDelete={setDeleteTarget}
            loadSecret={loadSecret}
          />
        )}
        {view === "audit" && <AuditList token={token} />}
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
            busy={busy}
            onSubmit={handleAddSingle}
            onClose={() => setAddSingleOpen(false)}
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
        onClose={() => setDeleteTarget(null)}
      />

      <Toaster
        position="bottom-center"
        toastOptions={{ className: "sm-toast", duration: 3500 }}
      />
    </div>
  );
}
