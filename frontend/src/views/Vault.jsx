import { useEffect, useMemo, useState } from "react";
import FilterChips from "../components/FilterChips.jsx";
import VaultTable from "../components/VaultTable.jsx";

const REVEAL_MS = 15000;

// The single vault screen: filter chips + dense ledger. Owns reveal state so
// that Esc masks every revealed row at once; each reveal self-expires after 15s.
export default function Vault({
  secrets,
  folders,
  meta,
  role,
  busy,
  searchTerm,
  folderFilter,
  onFolderFilter,
  onCopy,
  onEdit,
  onDelete,
  onAddFolder,
  evicted, // { n, ids } — bump n to drop revealed plaintext for ids
  loadSecret,
}) {
  // id -> { value, expiresAt }
  const [reveals, setReveals] = useState({});
  const [now, setNow] = useState(Date.now());

  // Tick once a second while anything is revealed, pruning expired entries.
  useEffect(() => {
    if (Object.keys(reveals).length === 0) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setReveals((current) => {
        let changed = false;
        const next = {};
        Object.entries(current).forEach(([id, entry]) => {
          if (entry.expiresAt > t) next[id] = entry;
          else changed = true;
        });
        return changed ? next : current;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [reveals]);

  // A secret that was edited/overwritten/deleted must not keep showing its old
  // plaintext, and reveals for ids that no longer exist are dropped.
  useEffect(() => {
    if (!evicted || !evicted.ids.length) return;
    setReveals((current) => {
      const next = { ...current };
      let changed = false;
      evicted.ids.forEach((id) => {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [evicted]);

  useEffect(() => {
    setReveals((current) => {
      const live = new Set(secrets.map((s) => s.id));
      const kept = Object.entries(current).filter(([id]) => live.has(id));
      return kept.length === Object.keys(current).length
        ? current
        : Object.fromEntries(kept);
    });
  }, [secrets]);

  // Esc masks all.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") setReveals({});
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleReveal(id) {
    try {
      const value = await loadSecret(id);
      setReveals((current) => ({
        ...current,
        [id]: { value, expiresAt: Date.now() + REVEAL_MS },
      }));
    } catch {
      // loadSecret surfaces its own toast.
    }
  }

  function handleMask(id) {
    setReveals((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  const counts = useMemo(() => {
    const map = {};
    secrets.forEach((s) => {
      map[s.folder] = (map[s.folder] || 0) + 1;
    });
    return map;
  }, [secrets]);

  const visible = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return secrets.filter((s) => {
      if (folderFilter !== "All" && s.folder !== folderFilter) return false;
      if (needle && !s.key.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [secrets, folderFilter, searchTerm]);

  // Decorate reveals with a live countdown for the visible rows.
  const revealView = useMemo(() => {
    const out = {};
    Object.entries(reveals).forEach(([id, entry]) => {
      out[id] = {
        value: entry.value,
        secondsLeft: Math.max(0, Math.ceil((entry.expiresAt - now) / 1000)),
      };
    });
    return out;
  }, [reveals, now]);

  return (
    <div className="space-y-4">
      <FilterChips
        folders={folders}
        counts={counts}
        total={secrets.length}
        active={folderFilter}
        onSelect={onFolderFilter}
        onAddFolder={role === "write" ? onAddFolder : undefined}
      />
      <VaultTable
        secrets={visible}
        meta={meta}
        reveals={revealView}
        role={role}
        busy={busy}
        onCopy={onCopy}
        onReveal={handleReveal}
        onMask={handleMask}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}
