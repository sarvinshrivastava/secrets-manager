import { describe, it, expect } from "vitest";
import {
  selectLocalDeletions,
  selectRemoteDeletions,
  classifyAsset,
} from "../src/backup/retention.js";
import { shiftSlot } from "../src/backup/schedule.js";

const HEX = "a".repeat(64);
const local = (slots) => slots.map((slot) => ({ name: `secrets-${slot}.db`, slot }));
const days = (from, n) => Array.from({ length: n }, (_, i) => shiftSlot(from, -i));
let nextId = 1;
const good = (slot, extra = {}) => ({
  id: nextId++,
  name: `secrets-${slot}.db.gz.age`,
  state: "uploaded",
  label: `sha256-${HEX}`,
  digest: `sha256:${HEX}`,
  ...extra,
});

describe("selectLocalDeletions", () => {
  it("keeps 14 of 20 consecutive daily files", () => {
    const files = local(days("20261020", 20));
    const del = selectLocalDeletions(files, { currentSlot: "20261020", keepDays: 14 });
    expect(del).toHaveLength(6);
    expect(del).toContain("secrets-20261001.db");
    expect(del).not.toContain("secrets-20261007.db");
  });

  it("keeps the newest 14 after a 30-day gap (floor)", () => {
    const files = local([...days("20260901", 16), "20261020"]);
    const del = selectLocalDeletions(files, { currentSlot: "20261020", keepDays: 14 });
    expect(del).toHaveLength(3);
    expect(del.sort()).toEqual(["secrets-20260817.db", "secrets-20260818.db", "secrets-20260819.db"]);
  });

  it("never deletes the current slot", () => {
    const files = local(["20261020", "20250101"]);
    const del = selectLocalDeletions(files, { currentSlot: "20261020", keepDays: 1 });
    expect(del).toEqual(["secrets-20250101.db"]);
  });
});

describe("classifyAsset", () => {
  it("classifies good / broken / foreign", () => {
    expect(classifyAsset(good("20261020"))).toBe("good");
    expect(classifyAsset(good("20261020", { digest: null }))).toBe("good");
    expect(classifyAsset(good("20261020", { state: "starter" }))).toBe("broken");
    expect(classifyAsset(good("20261020", { state: "starter", label: null }))).toBe("broken");
    expect(classifyAsset(good("20261020", { digest: `sha256:${"b".repeat(64)}` }))).toBe("broken");
    expect(classifyAsset(good("20261020", { name: "notes.txt" }))).toBe("foreign");
    expect(classifyAsset(good("20261020", { label: null }))).toBe("foreign");
    expect(classifyAsset(good("20261020", { label: "" }))).toBe("foreign");
    expect(classifyAsset(good("20261020", { label: "sha256-XYZ" }))).toBe("foreign");
  });
});

describe("selectRemoteDeletions", () => {
  const opts = { currentSlot: "20261020", keepDaily: 30, keepMonthly: 12 };

  it("keeps the newest 30 plus the oldest of each month", () => {
    const slots = days("20261020", 60); // 2026-08-22 … 2026-10-20
    const assets = slots.map((s) => good(s));
    const del = selectRemoteDeletions(assets, opts);
    const kept = assets.filter((a) => !del.includes(a.id)).map((a) => a.name.slice(8, 16));
    expect(kept).toHaveLength(32);
    expect(kept).toContain("20260822"); // oldest of August
    expect(kept).toContain("20260901"); // oldest of September
    expect(kept).not.toContain("20260902");
    expect(kept).toContain("20260921"); // 30th newest
    expect(kept).not.toContain("20260920");
  });

  it("deletes no good asset when 30 or fewer exist", () => {
    const assets = days("20261020", 30).map((s) => good(s));
    expect(selectRemoteDeletions(assets, opts)).toEqual([]);
  });

  it("deletes broken assets except the current slot's", () => {
    const cur = good("20261020", { state: "starter" });
    const old = good("20261019", { state: "starter" });
    const mismatch = good("20261018", { digest: `sha256:${"c".repeat(64)}` });
    const del = selectRemoteDeletions([cur, old, mismatch, good("20261017")], opts);
    expect(del.sort()).toEqual([old.id, mismatch.id].sort());
  });

  it("never touches label-less uploaded or foreign-named assets, and does not count them", () => {
    const labelless = days("20261020", 40).map((s) => good(s, { label: null }));
    const foreign = { id: 9999, name: "README.md", state: "uploaded", label: null, digest: null };
    const goods = days("20260801", 30).map((s) => good(s));
    const del = selectRemoteDeletions([...labelless, foreign, ...goods], opts);
    expect(del).toEqual([]);
  });

  it("counts months across a year boundary", () => {
    const cur = "20270110";
    const slots = days(cur, 100); // back to early October 2026
    const assets = slots.map((s) => good(s));
    const del = selectRemoteDeletions(assets, { currentSlot: cur, keepDaily: 30, keepMonthly: 3 });
    const kept = assets.filter((a) => !del.includes(a.id)).map((a) => a.name.slice(8, 16));
    // Months counted: Jan 2027 (current), Dec 2026, Nov 2026.
    expect(kept).toContain("20261201");
    expect(kept).toContain("20261101");
    expect(kept).not.toContain("20261102");
    expect(slots).toContain("20261003");
    expect(kept).not.toContain("20261003"); // October is month 4
    expect(kept).toHaveLength(32);
  });
});
