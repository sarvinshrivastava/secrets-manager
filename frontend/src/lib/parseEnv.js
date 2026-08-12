// Pure .env paste parser. No side effects, no I/O — safe to unit-test in isolation.
//
// parseEnvText(text, existingKeys) -> rows[]
// Each row: { line, key, value, status, reason }
//   status ∈ add | empty | exists | invalid | shadowed
//
// Rules (see redesign spec):
//   - ignore blank lines and lines starting with `#`
//   - strip a leading `export `
//   - split on the FIRST `=` OR `:`; trim spaces around the separator
//   - strip a matching pair of single/double quotes wrapping the value
//   - strip an inline `# comment` (only after a closing quote or an unquoted value)
//   - key must match ^[A-Za-z_][A-Za-z0-9_]*$ else `invalid`
//   - empty value -> `empty` (still addable)
//   - key already in existingKeys -> `exists` (skipped by default, per-row overwrite)
//   - same key twice in the paste -> the earlier row becomes `shadowed` (last wins)
//   - normalise CRLF / BOM / trailing spaces
//   - multi-line quoted values (e.g. PEM) -> `invalid`, not supported in v2

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Returns { value, multiline }. Ports the approved reference `stripInlineComment`
// and additionally flags an unterminated quoted value as multi-line.
function unquoteAndStripComment(rawVal) {
  const q = rawVal[0];
  if (q === '"' || q === "'") {
    const end = rawVal.indexOf(q, 1);
    if (end > 0) return { value: rawVal.slice(1, end), multiline: false };
    // Opening quote with no closing quote on this line -> multi-line value.
    return { value: rawVal, multiline: true };
  }
  const hash = rawVal.indexOf(" #");
  let value = rawVal;
  if (hash >= 0) value = value.slice(0, hash);
  return { value: value.trim(), multiline: false };
}

export function parseEnvText(text, existingKeys) {
  const existing =
    existingKeys instanceof Set
      ? existingKeys
      : new Set(Array.isArray(existingKeys) ? existingKeys : []);

  const rows = [];
  const last = {}; // key -> most-recent row (for shadowing)

  const normalised = String(text == null ? "" : text).replace(/^﻿/, "");

  normalised.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line[0] === "#") return;

    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const match = stripped.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);

    if (!match) {
      rows.push({
        line: index + 1,
        key: line.slice(0, 28),
        value: "",
        status: "invalid",
        reason: "no key=value separator",
      });
      return;
    }

    const key = match[1].trim();
    const { value, multiline } = unquoteAndStripComment(match[2].trim());

    if (!KEY_RE.test(key)) {
      rows.push({
        line: index + 1,
        key,
        value: "",
        status: "invalid",
        reason: "key must match [A-Za-z_][A-Za-z0-9_]*",
      });
      return;
    }

    if (multiline) {
      rows.push({
        line: index + 1,
        key,
        value: "",
        status: "invalid",
        reason: "multi-line values not supported (v2)",
      });
      return;
    }

    const row = { line: index + 1, key, value, status: "add", reason: "" };
    if (value === "") row.status = "empty";
    if (existing.has(key)) {
      row.status = "exists";
      row.reason = "already in vault";
    }

    if (last[key]) {
      last[key].status = "shadowed";
      last[key].reason = `overridden by line ${index + 1}`;
    }
    last[key] = row;
    rows.push(row);
  });

  return rows;
}

export default parseEnvText;
