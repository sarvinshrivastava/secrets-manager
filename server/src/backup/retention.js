// Retention selection. Pure: callers list, these functions pick, callers
// delete. Only names this feature writes are ever selected.
import { shiftSlot } from "./schedule.js";

export const REMOTE_RE = /^secrets-(\d{8})\.db\.gz\.age$/;
export const LABEL_RE = /^sha256-([0-9a-f]{64})$/;

// Keep every slot of the last `keepDays` days, the newest `keepDays` files
// whatever their age, and the current slot. Delete the rest.
export function selectLocalDeletions(files, { currentSlot, keepDays }) {
  const cutoff = shiftSlot(currentSlot, -(keepDays - 1));
  const newest = new Set(
    [...files]
      .sort((a, b) => b.slot.localeCompare(a.slot))
      .slice(0, keepDays)
      .map((f) => f.name),
  );
  return files
    .filter(
      (f) => f.slot !== currentSlot && f.slot < cutoff && !newest.has(f.name),
    )
    .map((f) => f.name);
}

// foreign: not our name, or uploaded without our label (possibly a good copy
//          made by hand: never deleted, never counted).
// broken:  our name, but not fully uploaded, or GitHub's digest disagrees
//          with the label.
// good:    our name, uploaded, our label, digest null or equal.
export function classifyAsset(asset) {
  if (!REMOTE_RE.test(asset.name ?? "")) return "foreign";
  if (asset.state !== "uploaded") return "broken";
  const label = LABEL_RE.exec(asset.label ?? "");
  if (!label) return "foreign";
  if (asset.digest != null && asset.digest !== `sha256:${label[1]}`) {
    return "broken";
  }
  return "good";
}

function monthsBack(slot, count) {
  let y = Number(slot.slice(0, 4));
  let m = Number(slot.slice(4, 6));
  const months = [];
  for (let i = 0; i < count; i += 1) {
    months.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

// Keep the newest `keepDaily` good slots, the oldest good slot of each of the
// last `keepMonthly` UTC months (counting the current one), and the current
// slot. Broken assets are deleted except the current slot's (the runner
// handles that one). Foreign assets are never touched.
export function selectRemoteDeletions(
  assets,
  { currentSlot, keepDaily, keepMonthly },
) {
  const good = [];
  const deletions = [];
  for (const a of assets) {
    const kind = classifyAsset(a);
    const slot = REMOTE_RE.exec(a.name ?? "")?.[1];
    if (kind === "good") good.push({ id: a.id, slot });
    else if (kind === "broken" && slot !== currentSlot) deletions.push(a.id);
  }
  if (good.length <= keepDaily) return deletions;

  good.sort((a, b) => b.slot.localeCompare(a.slot));
  const keep = new Set([currentSlot]);
  for (const g of good.slice(0, keepDaily)) keep.add(g.slot);
  for (const month of monthsBack(currentSlot, keepMonthly)) {
    const inMonth = good.filter((g) => g.slot.startsWith(month));
    if (inMonth.length > 0) keep.add(inMonth[inMonth.length - 1].slot);
  }
  for (const g of good) if (!keep.has(g.slot)) deletions.push(g.id);
  return deletions;
}
