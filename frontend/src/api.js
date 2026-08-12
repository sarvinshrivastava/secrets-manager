// Centralised API client.
// - 15s request timeout via AbortSignal.timeout
// - on 401: clear the stored token and notify the app once (no endless toasts)

const REQUEST_TIMEOUT_MS = 15000;

let onUnauthorized = null;

// The app registers a single handler; api.js calls it exactly once per 401.
export function setUnauthorizedHandler(fn) {
  onUnauthorized = typeof fn === "function" ? fn : null;
}

function timeoutSignal() {
  // AbortSignal.timeout is supported in all evergreen browsers; fall back to
  // a manual controller where it is not.
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return controller.signal;
}

async function apiFetch(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      signal: timeoutSignal(),
    });
  } catch (error) {
    if (
      error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("Request timed out");
    }
    throw new Error(error?.message || "Network error");
  }

  if (response.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload.detail) detail = payload.detail;
    } catch {
      // Ignore non-JSON failures.
    }
    throw new Error(detail);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export function getMe(token) {
  return apiFetch("/api/auth/me", token);
}

export function listSecrets(token) {
  return apiFetch("/api/secrets", token);
}

export function getFolders(token) {
  return apiFetch("/api/folders", token);
}

export function getSecret(token, folder, key) {
  return apiFetch(
    `/api/secrets/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`,
    token,
  );
}

export function createSecret(token, key, value, folder) {
  return apiFetch("/api/secrets", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, folder }),
  });
}

// POST /api/secrets/bulk -> { added, updated, skipped, invalid, folder }
export function bulkCreateSecrets(token, folder, secrets, overwrite = []) {
  return apiFetch("/api/secrets/bulk", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, secrets, overwrite }),
  });
}

export function deleteSecret(token, folder, key) {
  return apiFetch(
    `/api/secrets/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`,
    token,
    { method: "DELETE" },
  );
}

export function exportSecrets(token) {
  return apiFetch("/api/exports", token);
}

export function listAuditLogs(
  token,
  { action, status, key, limit = 200 } = {},
) {
  const params = new URLSearchParams();
  if (action && action !== "all") params.set("action", action);
  if (status && status !== "all") params.set("status", status);
  if (key && key.trim()) params.set("key", key.trim());
  params.set("limit", String(limit));
  return apiFetch(`/api/audit-logs?${params.toString()}`, token);
}

export function renameFolder(token, from, to) {
  return apiFetch("/api/folders/rename", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export function listTokens(token) {
  return apiFetch("/api/tokens", token);
}

export function createToken(token, name, role, expiresInSeconds) {
  return apiFetch("/api/tokens", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      role,
      ...(expiresInSeconds ? { expires_in_seconds: expiresInSeconds } : {}),
    }),
  });
}

export function revokeToken(token, name) {
  return apiFetch(`/api/tokens/${encodeURIComponent(name)}`, token, {
    method: "DELETE",
  });
}

export function rotateToken(token, name, customToken) {
  return apiFetch(`/api/tokens/${encodeURIComponent(name)}/rotate`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(customToken ? { token: customToken } : {}),
  });
}
