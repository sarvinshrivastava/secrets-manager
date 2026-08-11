export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FOLDER_NAME_REGEX = /^[A-Za-z0-9 _.-]{1,128}$/;

export function isValidFolderName(name) {
  return typeof name === "string" && FOLDER_NAME_REGEX.test(name);
}

export function getClientIp(req, trustedProxyIps = []) {
  const remoteIp = req.socket?.remoteAddress || "unknown";
  // Only trust XFF when the direct peer is a trusted proxy. nginx APPENDS the
  // real client on the right, so an attacker can prepend spoofed entries on the
  // left — take the RIGHTMOST entry that is not itself a known trusted proxy.
  if (trustedProxyIps.includes(remoteIp)) {
    const forwardedFor = req.header("x-forwarded-for");
    if (forwardedFor) {
      const parts = forwardedFor
        .split(",")
        .map((ip) => ip.trim())
        .filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (!trustedProxyIps.includes(parts[i])) {
          return parts[i];
        }
      }
      // Every hop was a trusted proxy — fall back to the leftmost entry.
      if (parts.length > 0) return parts[0];
    }
  }
  return remoteIp;
}

export function extractToken(req) {
  const authHeader = req.header("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const apiKey = req.header("x-api-key");
  if (apiKey) return apiKey.trim();

  return null;
}

// Single-pass unescape driven by an alternation + lookup table so escape
// sequences can never be re-scanned (the old sequential .replace() chain ran
// `\\`->`\` before `\n`->newline, corrupting a literal backslash-n).
const UNESCAPE_MAP = {
  "\\\\": "\\",
  "\\n": "\n",
  "\\r": "\r",
  "\\t": "\t",
  '\\"': '"',
};
const UNESCAPE_REGEX = /\\[\\nrt"]/g;

export function parseEnvValue(rawValue) {
  const value = rawValue.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner.replace(UNESCAPE_REGEX, (match) => UNESCAPE_MAP[match]);
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

// Single-pass escape — one regex over the raw chars so no substitution output
// is ever re-scanned (order-independent, inverse of parseEnvValue).
const ESCAPE_MAP = {
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  '"': '\\"',
};
const ESCAPE_REGEX = /[\\\n\r\t"]/g;

export function formatEnvValue(value) {
  const escaped = value.replace(ESCAPE_REGEX, (match) => ESCAPE_MAP[match]);
  return `"${escaped}"`;
}

export function requireEnvKey(key) {
  return ENV_KEY_REGEX.test(key);
}

// Token wire format: `<name>.<secret>`. The name is a NON-SECRET lookup id that
// lets auth verify a single PBKDF2 hash (O(1)) instead of scanning every token.
// Returns { name, secret } if the token carries a parseable name, else null
// (bare legacy/bootstrap tokens fall back to a capped scan).
export const TOKEN_NAME_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function parseNamedToken(token) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const name = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!TOKEN_NAME_REGEX.test(name)) return null;
  return { name, secret };
}

// Scope is stored as CSV of folder names, or `*` = all folders.
export function scopeAllowsFolder(scopeCsv, folder) {
  if (!scopeCsv || scopeCsv === "*") return true;
  const allowed = scopeCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes("*")) return true;
  return allowed.includes(folder);
}
