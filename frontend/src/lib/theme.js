// Theme preference: "auto" follows the browser/OS (live), "light"/"dark" pin it.
// Stored under its own key — the legacy `sm_theme` value was written on every
// visit with the OS-resolved theme, so it is NOT a deliberate choice and is
// ignored (every browser starts on auto).
export const THEME_PREF_KEY = "sm_theme_pref";
export const THEME_PREFS = ["auto", "light", "dark"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemQuery() {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia(DARK_QUERY);
    }
  } catch {
    // fall through
  }
  return null;
}

export function readThemePref() {
  try {
    const stored = localStorage.getItem(THEME_PREF_KEY);
    return THEME_PREFS.includes(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function writeThemePref(pref) {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
  } catch {
    // storage blocked: the preference just won't persist
  }
}

// auto -> whatever the browser currently prefers; otherwise the pinned value.
export function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return systemQuery()?.matches ? "dark" : "light";
}

export function applyTheme(resolved) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // Also tag light so the pre-JS prefers-color-scheme fallback in styles.css
  // never repaints a pinned-light page dark.
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
}

export function nextThemePref(pref) {
  return THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length];
}

// Calls cb whenever the browser's colour-scheme preference changes. Returns an
// unsubscribe function. Falls back to addListener on old Safari.
export function subscribeSystemTheme(cb) {
  const query = systemQuery();
  if (!query) return () => {};
  const handler = () => cb();
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }
  if (typeof query.addListener === "function") {
    query.addListener(handler);
    return () => query.removeListener(handler);
  }
  return () => {};
}
