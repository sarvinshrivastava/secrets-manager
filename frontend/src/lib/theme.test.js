import { describe, it, expect } from "vitest";
import {
  THEME_PREF_KEY,
  applyTheme,
  nextThemePref,
  readThemePref,
  resolveTheme,
  subscribeSystemTheme,
} from "./theme.js";

describe("theme", () => {
  it("ignores the legacy sm_theme value: everyone starts on auto", () => {
    localStorage.setItem("sm_theme", "light");
    expect(readThemePref()).toBe("auto");
  });

  it("reads a stored preference and rejects junk", () => {
    localStorage.setItem(THEME_PREF_KEY, "dark");
    expect(readThemePref()).toBe("dark");
    localStorage.setItem(THEME_PREF_KEY, "purple");
    expect(readThemePref()).toBe("auto");
  });

  it("auto follows the browser; pinned values do not", () => {
    globalThis.__setSystemDark(true);
    expect(resolveTheme("auto")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    globalThis.__setSystemDark(false);
    expect(resolveTheme("auto")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("cycles auto -> light -> dark -> auto", () => {
    expect(nextThemePref("auto")).toBe("light");
    expect(nextThemePref("light")).toBe("dark");
    expect(nextThemePref("dark")).toBe("auto");
  });

  it("applyTheme toggles the dark and light classes", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("subscribeSystemTheme fires on change and unsubscribes", () => {
    let calls = 0;
    const off = subscribeSystemTheme(() => {
      calls += 1;
    });
    globalThis.__setSystemDark(true);
    expect(calls).toBe(1);
    off();
    globalThis.__setSystemDark(false);
    expect(calls).toBe(1);
  });
});
