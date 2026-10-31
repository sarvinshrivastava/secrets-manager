import "@testing-library/jest-dom";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom 30 does not expose a working localStorage/sessionStorage by default.
// Provide a minimal in-memory polyfill so app code that reads/writes storage
// behaves deterministically in tests.
function createMemoryStorage() {
  let store = {};
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

// jsdom has no matchMedia; react-hot-toast (and theme detection) call it.
// Controllable: tests call globalThis.__setSystemDark(true|false) to flip the
// browser colour scheme and fire "change" listeners.
let systemDark = false;
const mediaListeners = new Set();
globalThis.__setSystemDark = (value) => {
  systemDark = Boolean(value);
  mediaListeners.forEach((fn) => fn({ matches: systemDark }));
};
globalThis.__mediaListenerCount = () => mediaListeners.size;
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = (query) => ({
    get matches() {
      return /prefers-color-scheme:\s*dark/.test(query) ? systemDark : false;
    },
    media: query,
    onchange: null,
    addListener: (fn) => mediaListeners.add(fn),
    removeListener: (fn) => mediaListeners.delete(fn),
    addEventListener: (_type, fn) => mediaListeners.add(fn),
    removeEventListener: (_type, fn) => mediaListeners.delete(fn),
    dispatchEvent: () => false,
  });
}

// jsdom has no scrollIntoView; @headlessui/react (the Add menu) calls it.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.scrollIntoView !== "function"
) {
  Element.prototype.scrollIntoView = () => {};
}

if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = createMemoryStorage();
}
if (typeof globalThis.sessionStorage === "undefined") {
  globalThis.sessionStorage = createMemoryStorage();
}

beforeEach(() => {
  systemDark = false;
  mediaListeners.clear();
  document.documentElement.className = "";
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});
