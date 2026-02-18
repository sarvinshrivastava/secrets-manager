export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getClientIp(req, trustedProxyIps = []) {
  const remoteIp = req.socket?.remoteAddress || "unknown";
  if (trustedProxyIps.includes(remoteIp)) {
    const forwardedFor = req.header("x-forwarded-for");
    if (forwardedFor) {
      return forwardedFor.split(",", 1)[0].trim();
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

export function parseEnvValue(rawValue) {
  const value = rawValue.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

export function formatEnvValue(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function requireEnvKey(key) {
  return ENV_KEY_REGEX.test(key);
}
