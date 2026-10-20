// Slot arithmetic for the daily backup. Pure: every function takes its clock
// as an argument. A slot is named by the UTC date of its scheduled run.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "HH:MM" (UTC, 00:00–23:59) → { hour, minute }, or null when invalid.
export function parseUtcTime(str) {
  const m = TIME_RE.exec(String(str ?? ""));
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}
