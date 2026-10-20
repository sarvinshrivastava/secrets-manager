import { describe, it, expect } from "vitest";
import {
  parseUtcTime,
  slotName,
  slotStart,
  shiftSlot,
  dueSlot,
  nextSlotStart,
  RETRY_DELAYS_MS,
  RUN_DEADLINE_MS,
} from "../src/backup/schedule.js";
import {
  BackupError,
  CODES,
  NOTES,
  toBackupError,
} from "../src/backup/errors.js";

const T = { hour: 22, minute: 30 };
const d = (iso) => new Date(iso);

describe("schedule", () => {
  it("parseUtcTime accepts HH:MM and rejects the rest", () => {
    expect(parseUtcTime("22:30")).toEqual({ hour: 22, minute: 30 });
    expect(parseUtcTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseUtcTime("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["24:00", "-1:00", "12:60", "7:5", "ab", "", null, undefined]) {
      expect(parseUtcTime(bad)).toBeNull();
    }
  });

  it("slotName is the UTC date", () => {
    expect(slotName(d("2026-10-20T23:59:59Z"))).toBe("20261020");
    expect(slotName(d("2026-10-21T00:00:00Z"))).toBe("20261021");
  });

  it("slotStart is the slot date at HH:MM UTC", () => {
    expect(slotStart("20261020", T).toISOString()).toBe(
      "2026-10-20T22:30:00.000Z",
    );
  });

  it("dueSlot around the slot boundary", () => {
    expect(dueSlot(d("2026-10-20T22:29:59Z"), T)).toBe("20261019");
    expect(dueSlot(d("2026-10-20T22:30:00Z"), T)).toBe("20261020");
    expect(dueSlot(d("2026-10-20T23:59:00Z"), T)).toBe("20261020");
    expect(dueSlot(d("2026-10-21T00:10:00Z"), T)).toBe("20261020");
  });

  it("nextSlotStart around the boundary", () => {
    expect(nextSlotStart(d("2026-10-20T22:29:59Z"), T).toISOString()).toBe(
      "2026-10-20T22:30:00.000Z",
    );
    expect(nextSlotStart(d("2026-10-20T22:30:00Z"), T).toISOString()).toBe(
      "2026-10-21T22:30:00.000Z",
    );
  });

  it("rolls over months and years", () => {
    expect(dueSlot(d("2027-01-01T00:10:00Z"), T)).toBe("20261231");
    expect(nextSlotStart(d("2026-12-31T23:00:00Z"), T).toISOString()).toBe(
      "2027-01-01T22:30:00.000Z",
    );
    expect(shiftSlot("20261231", 1)).toBe("20270101");
    expect(shiftSlot("20260301", -1)).toBe("20260228");
    expect(shiftSlot("20280301", -1)).toBe("20280229");
  });

  it("handles a 00:00 slot time", () => {
    const z = { hour: 0, minute: 0 };
    expect(dueSlot(d("2026-10-20T00:00:00Z"), z)).toBe("20261020");
    expect(dueSlot(d("2026-10-19T23:59:59Z"), z)).toBe("20261019");
    expect(nextSlotStart(d("2026-10-20T00:00:00Z"), z).toISOString()).toBe(
      "2026-10-21T00:00:00.000Z",
    );
  });

  it("exports the retry delays and run deadline", () => {
    expect(RETRY_DELAYS_MS).toEqual([900_000, 1_800_000]);
    expect(RUN_DEADLINE_MS).toBe(1_200_000);
  });
});

describe("errors", () => {
  it("has a closed set of 17 codes and 4 notes", () => {
    expect(CODES).toHaveLength(17);
    expect(NOTES).toHaveLength(4);
  });

  it("BackupError message is the code; retryability from NON_RETRYABLE only", () => {
    const e = new BackupError("github_5xx");
    expect(e.message).toBe("github_5xx");
    expect(e.retryable).toBe(true);
    expect(new BackupError("config_invalid").retryable).toBe(false);
    expect(new BackupError("slot_asset_foreign").retryable).toBe(false);
    expect(new BackupError("token_expiring").retryable).toBe(false);
    expect(new BackupError("private_key_on_vps").retryable).toBe(false);
    expect(new BackupError("verify_mismatch").retryable).toBe(true);
    expect(new BackupError("not-a-code").code).toBe("internal");
  });

  it("toBackupError maps causes to codes", () => {
    const fsErr = (code) => Object.assign(new Error("x"), { code, syscall: "open" });
    expect(toBackupError(fsErr("ENOSPC"), "local").code).toBe("disk_low");
    expect(
      toBackupError(Object.assign(new Error("full"), { code: "SQLITE_FULL" }), "snapshot").code,
    ).toBe("disk_low");
    expect(toBackupError(fsErr("EACCES"), "local").code).toBe("local_failed");
    expect(toBackupError(fsErr("EACCES"), "snapshot").code).toBe("local_failed");
    const sqlErr = Object.assign(new Error("busy"), { name: "SqliteError", code: "SQLITE_BUSY" });
    expect(toBackupError(sqlErr, "local").code).toBe("snapshot_failed");
    expect(toBackupError(new TypeError("closed"), "snapshot").code).toBe("snapshot_failed");
    expect(toBackupError(new TypeError(), "local").code).toBe("internal");
    expect(toBackupError(new TypeError(), "offsite").code).toBe("internal");
    const be = new BackupError("disk_low");
    expect(toBackupError(be, "x")).toBe(be);
  });
});
