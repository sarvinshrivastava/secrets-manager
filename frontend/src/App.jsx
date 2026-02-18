import { useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "react-hot-toast";
import {
  getMe,
  listSecrets,
  getSecret,
  createSecret,
  deleteSecret,
  renameFolder,
} from "./api.js";
import Login from "./views/Login.jsx";
import Dashboard from "./views/Dashboard.jsx";
import Secrets from "./views/Secrets.jsx";
import AuditLogs from "./views/AuditLogs.jsx";
import Settings from "./views/Settings.jsx";
import Sidebar from "./components/Sidebar.jsx";
import CreateDrawer from "./components/CreateDrawer.jsx";
import DeleteDialog from "./components/DeleteDialog.jsx";

const SESSION_TOKEN_KEY = "sm_token_session";
const PERSIST_TOKEN_KEY = "sm_token_persist";

const EMPTY_DRAFT = {
  key: "",
  value: "",
  description: "",
  folder: "Root",
  tags: "",
};

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
  const [tokenVisible, setTokenVisible] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(
    () => Boolean(localStorage.getItem(PERSIST_TOKEN_KEY)),
  );

  const [role, setRole] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [keys, setKeys] = useState([]);
  const [keyFolders, setKeyFolders] = useState({});

  const [searchTerm, setSearchTerm] = useState("");
  const [view, setView] = useState("dashboard");

  const [secretCache, setSecretCache] = useState({});
  const [secretMeta, setSecretMeta] = useState({});

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [defaultFolderName, setDefaultFolderName] = useState(
    () => localStorage.getItem("sm_default_folder") || "Root",
  );
  const [folders, setFolders] = useState(() => {
    const stored = localStorage.getItem("sm_folders");
    const defaultFolder = localStorage.getItem("sm_default_folder") || "Root";
    const nextFolders = stored
      ? JSON.parse(stored)
      : ["Root", "Production", "Staging", "Development"];
    if (!Array.isArray(nextFolders) || nextFolders.length === 0)
      return [defaultFolder];
    if (!nextFolders.includes(defaultFolder))
      return [defaultFolder, ...nextFolders];
    return nextFolders;
  });
  const [newFolderName, setNewFolderName] = useState("");
  const [defaultFolderDraft, setDefaultFolderDraft] = useState(
    () => localStorage.getItem("sm_default_folder") || "Root",
  );

  const signedIn = useMemo(() => Boolean(token && role), [token, role]);

  const filteredKeys = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return keys;
    return keys.filter((keyName) => keyName.toLowerCase().includes(needle));
  }, [keys, searchTerm]);

  function resetState() {
    setRole("");
    setTokenName("");
    setKeys([]);
    setKeyFolders({});
    setSearchTerm("");
    setView("dashboard");
    setSecretCache({});
    setSecretMeta({});
    setDrawerOpen(false);
    setDeleteOpen(false);
    setDeleteTarget("");
  }

  async function refreshSecrets(activeToken = token, notify = true) {
    const payload = await listSecrets(activeToken);
    const rawKeys = payload.keys || [];

    const nextKeys = rawKeys.map((item) =>
      typeof item === "string" ? item : item.key,
    );
    const nextKeyFolders = {};
    rawKeys.forEach((item) => {
      if (typeof item === "string") {
        nextKeyFolders[item] = defaultFolderName;
      } else if (item && item.key) {
        nextKeyFolders[item.key] = item.folder || defaultFolderName;
      }
    });

    setKeys(nextKeys);
    setKeyFolders(nextKeyFolders);

    if (notify) toast.success("Secrets refreshed");
  }

  async function validateAndLoad(activeToken) {
    const me = await getMe(activeToken);
    setRole(me.role);
    setTokenName(me.token_name);
    await refreshSecrets(activeToken, false);
  }

  useEffect(() => {
    if (!token) {
      setLoading(false);
      resetState();
      return;
    }

    let cancelled = false;
    setLoading(true);

    validateAndLoad(token)
      .then(() => {
        if (!cancelled) {
          toast.success("Identity verified");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        clearStoredToken();
        setToken("");
        resetState();
        toast.error(`Login required: ${error.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    localStorage.setItem("sm_folders", JSON.stringify(folders));
  }, [folders]);

  useEffect(() => {
    localStorage.setItem("sm_default_folder", defaultFolderName);
    setDefaultFolderDraft(defaultFolderName);
  }, [defaultFolderName]);

  useEffect(() => {
    if (folders.includes(defaultFolderName)) return;
    setFolders((current) => [
      defaultFolderName,
      ...current.filter((folder) => folder !== defaultFolderName),
    ]);
  }, [folders, defaultFolderName]);

  async function loadSecret(keyName, notify = false) {
    if (secretCache[keyName] !== undefined) {
      if (notify) toast.success(`${keyName} loaded`);
      return secretCache[keyName];
    }

    const folder = keyFolders[keyName] || defaultFolderName;
    const payload = await getSecret(token, folder, keyName);
    setSecretCache((current) => ({ ...current, [keyName]: payload.value }));
    setSecretMeta((current) => ({
      ...current,
      [keyName]: {
        createdAt: payload.created_at,
        folder: payload.folder || defaultFolderName,
      },
    }));

    if (notify) toast.success(`${keyName} loaded`);
    return payload.value;
  }

  async function handleCopy(keyName) {
    if (!keyName) return;

    setBusy(true);
    try {
      const value = await loadSecret(keyName, false);
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable in this browser");
      }
      await navigator.clipboard.writeText(value);
      toast.success("Token copied to clipboard");
    } catch (error) {
      toast.error(`Copy failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setLoading(true);
    try {
      await refreshSecrets(token, true);
    } catch (error) {
      toast.error(`Refresh failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    clearStoredToken();
    setToken("");
    setTokenInput("");
    resetState();
    toast.success("Logged out");
  }

  function handleAddFolder() {
    const folderName = newFolderName.trim();
    if (!folderName) {
      toast.error("Folder name is required");
      return;
    }
    if (folders.includes(folderName)) {
      toast.error("Folder already exists");
      return;
    }
    setFolders((current) => [...current, folderName]);
    setNewFolderName("");
    toast.success(`Folder "${folderName}" created`);
  }

  function handleDeleteFolder(folderName) {
    if (folderName === defaultFolderName) {
      toast.error("Cannot delete the default folder");
      return;
    }
    setFolders((current) => current.filter((f) => f !== folderName));
    toast.success(`Folder "${folderName}" deleted`);
  }

  async function handleRenameDefaultFolder() {
    const nextFolderName = defaultFolderDraft.trim();
    if (!nextFolderName) {
      toast.error("Default folder name is required");
      return;
    }
    if (nextFolderName === defaultFolderName) {
      toast("Default folder name unchanged", { icon: "i" });
      return;
    }
    if (folders.includes(nextFolderName)) {
      toast.error("A folder with this name already exists");
      return;
    }
    if (role !== "write") {
      toast.error("Write token required to rename the default folder");
      return;
    }

    setLoading(true);
    try {
      const payload = await renameFolder(token, defaultFolderName, nextFolderName);

      setFolders((current) =>
        current.map((folder) =>
          folder === defaultFolderName ? nextFolderName : folder,
        ),
      );
      setDefaultFolderName(nextFolderName);
      setDraft((current) => ({
        ...current,
        folder:
          current.folder === defaultFolderName
            ? nextFolderName
            : current.folder,
      }));

      await refreshSecrets(token, false);
      toast.success(
        `Default folder renamed to "${nextFolderName}" (${payload.renamed || 0} secrets updated)`,
      );
    } catch (error) {
      toast.error(`Rename failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function handleLogin(event) {
    event.preventDefault();
    const nextToken = tokenInput.trim();

    if (!nextToken) {
      toast.error("Security token is required");
      return;
    }

    setLoading(true);
    resetState();
    storeToken(nextToken, rememberLogin);
    setToken(nextToken);
    setTokenInput("");
    toast("Verifying identity...", { icon: "i" });
  }

  function openCreateDrawer() {
    if (role !== "write") {
      toast.error("Write token required to create secrets");
      return;
    }
    setDraft({ ...EMPTY_DRAFT, folder: defaultFolderName });
    setDrawerOpen(true);
  }

  async function handleDrawerSubmit(event) {
    event.preventDefault();

    if (role !== "write") {
      toast.error("Write token required");
      return;
    }

    const keyName = draft.key.trim();
    if (!keyName || !draft.value) {
      toast.error("Name and secret value are required");
      return;
    }
    if (keys.includes(keyName)) {
      toast.error("Secret name already exists. Create-only mode is enabled.");
      return;
    }

    setLoading(true);
    try {
      await createSecret(
        token,
        keyName,
        draft.value,
        draft.folder || defaultFolderName,
      );

      setSecretCache((current) => ({ ...current, [keyName]: draft.value }));
      setSecretMeta((current) => ({
        ...current,
        [keyName]: {
          createdAt: new Date().toISOString(),
          folder: draft.folder || defaultFolderName,
        },
      }));
      setKeyFolders((current) => ({
        ...current,
        [keyName]: draft.folder || defaultFolderName,
      }));

      await refreshSecrets(token, false);
      setDrawerOpen(false);
      setView("dashboard");
      setDraft({ ...EMPTY_DRAFT, folder: defaultFolderName });

      toast.success(`Created ${keyName}`);
    } catch (error) {
      toast.error(`Save failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function requestDelete(keyName) {
    if (role !== "write") {
      toast.error("Write token required to delete secrets");
      return;
    }
    setDeleteTarget(keyName);
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;

    setBusy(true);
    try {
      const folder = keyFolders[deleteTarget] || defaultFolderName;
      await deleteSecret(token, folder, deleteTarget);

      setSecretCache((current) => {
        const next = { ...current };
        delete next[deleteTarget];
        return next;
      });
      setSecretMeta((current) => {
        const next = { ...current };
        delete next[deleteTarget];
        return next;
      });

      await refreshSecrets(token, false);
      setDeleteOpen(false);
      setDeleteTarget("");
      toast.success("Credential deleted");
    } catch (error) {
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
          tokenVisible={tokenVisible}
          setTokenVisible={setTokenVisible}
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
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      <Sidebar
        activeView={view}
        onViewChange={(newView) => {
          setView(newView);
          setSidebarOpen(false);
        }}
        onLogout={handleLogout}
        role={role}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex-1 flex flex-col overflow-hidden w-full lg:w-auto">
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {view === "dashboard" && (
            <Dashboard
              keys={keys}
              folders={folders}
              filteredKeys={filteredKeys}
              keyFolders={keyFolders}
              defaultFolderName={defaultFolderName}
              secretCache={secretCache}
              secretMeta={secretMeta}
              role={role}
              busy={busy}
              authToken={token}
              onCopy={handleCopy}
              onDelete={requestDelete}
              onCreateSecret={openCreateDrawer}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              onRefresh={handleRefresh}
              loading={loading}
              onMenuClick={() => setSidebarOpen(true)}
            />
          )}
          {view === "secrets" && (
            <Secrets
              keys={keys}
              keyFolders={keyFolders}
              folders={folders}
              filteredKeys={filteredKeys}
              defaultFolderName={defaultFolderName}
              defaultFolderDraft={defaultFolderDraft}
              setDefaultFolderDraft={setDefaultFolderDraft}
              newFolderName={newFolderName}
              setNewFolderName={setNewFolderName}
              secretCache={secretCache}
              secretMeta={secretMeta}
              role={role}
              busy={busy}
              loading={loading}
              authToken={token}
              onCopy={handleCopy}
              onDelete={requestDelete}
              onRenameDefaultFolder={handleRenameDefaultFolder}
              onAddFolder={handleAddFolder}
              onDeleteFolder={handleDeleteFolder}
              onMenuClick={() => setSidebarOpen(true)}
            />
          )}
          {view === "audit" && (
            <AuditLogs
              token={token}
              onMenuClick={() => setSidebarOpen(true)}
            />
          )}
          {view === "settings" && (
            <Settings
              tokenName={tokenName}
              role={role}
              token={token}
              onLogout={handleLogout}
              onMenuClick={() => setSidebarOpen(true)}
            />
          )}
        </main>
      </div>

      <CreateDrawer
        open={drawerOpen}
        draft={draft}
        onDraftChange={(partial) => setDraft((current) => ({ ...current, ...partial }))}
        folders={folders}
        loading={loading}
        onSubmit={handleDrawerSubmit}
        onClose={() => setDrawerOpen(false)}
      />

      <DeleteDialog
        open={deleteOpen}
        target={deleteTarget}
        busy={busy}
        onConfirm={confirmDelete}
        onClose={() => setDeleteOpen(false)}
      />

      <Toaster
        position="bottom-center"
        toastOptions={{ className: "sm-toast", duration: 3500 }}
      />
    </div>
  );
}
