// Slot arithmetic for the daily backup. Pure: every function takes its clock
// as an argument. A slot is named by the UTC date of its scheduled run.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "HH:MM" (UTC, 00:00–23:59) → { hour, minute }, or null when invalid.
export function parseUtcTime(str) {
  const m = TIME_RE.exec(String(str ?? ""));
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

// UTC date of `date` as "YYYYMMDD".
export function slotName(date) {
  return (
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate())
  );
}

function slotMidnightMs(slot) {
  return Date.UTC(
    Number(slot.slice(0, 4)),
    Number(slot.slice(4, 6)) - 1,
    Number(slot.slice(6, 8)),
  );
}

// The slot's date at HH:MM UTC.
export function slotStart(slot, time) {
  return new Date(
    slotMidnightMs(slot) + (time.hour * 60 + time.minute) * 60_000,
  );
}

// `slot` moved by `days` (negative = earlier).
export function shiftSlot(slot, days) {
  return slotName(new Date(slotMidnightMs(slot) + days * DAY_MS));
}

// Latest slot whose start is <= now.
export function dueSlot(now, time) {
  const today = slotName(now);
  return slotStart(today, time) <= now ? today : shiftSlot(today, -1);
}

// Earliest slot start strictly after now.
export function nextSlotStart(now, time) {
  const today = slotStart(slotName(now), time);
  return today > now ? today : new Date(today.getTime() + DAY_MS);
}

export const RETRY_DELAYS_MS = [15 * 60_000, 30 * 60_000]; // attempts 2 and 3
export const RUN_DEADLINE_MS = 20 * 60_000;
