// Small pure formatting/storage helpers shared across the UI.

export function relativeAge(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 2592000)}mo`;
}

// A fixed-width dot mask — never derived from the real value length so it
// leaks nothing about the secret.
export const DOT_MASK = "••••••••••••";

// Composite folder+key identity. The backend allows the same key in different
// folders (UNIQUE(folder,key)), so key alone is NOT a unique handle.
export function secretId(folder, key) {
  return `${folder} ${key}`;
}

// Guarded JSON read — a corrupt localStorage value must never white-screen the app.
export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
