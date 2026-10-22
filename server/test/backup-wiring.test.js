import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBackups } from "../src/index.js";
import { parseBackupSettings } from "../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startBackups", () => {
  it("importing index.js starts nothing", () => {
    expect(typeof startBackups).toBe("function");
  });

  it("returns null when the feature is disabled", () => {
    expect(startBackups({ backup: { enabled: false } }, {})).toBeNull();
    expect(startBackups({}, {})).toBeNull();
  });

  it("returns a started runner with the catch-up and slot timers", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-wiring-"));
    try {
      const settings = {
        dbPath: path.join(dir, "secrets.db"),
        backup: parseBackupSettings({ SECRET_MANAGER_BACKUP_DIR: dir }),
      };
      const runner = startBackups(settings, { insertAuditLog() {} }, {
        log: { info() {}, warn() {}, error() {} },
      });
      expect(runner).not.toBeNull();
      expect(typeof runner.stop).toBe("function");
      expect(vi.getTimerCount()).toBe(2);
      runner.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs and returns null when the backup dir was refused", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(startBackups({ backup: { enabled: false, error: "config_invalid" } }, {})).toBeNull();
    expect(spy).toHaveBeenCalledWith("backup disabled: config_invalid");
  });

  it("returns null and logs the error name when creation throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = startBackups({ backup: { enabled: true } }, {}, {
      createBackupRunner: () => {
        throw new Error("secret detail");
      },
    });
    expect(runner).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("backup start failed: Error");
  });
});
