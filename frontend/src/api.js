function apiFetch(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(path, { ...options, headers }).then(async (response) => {
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
  });
}

export function getMe(token) {
  return apiFetch("/api/auth/me", token);
}

export function listSecrets(token) {
  return apiFetch("/api/secrets", token);
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

export function listAuditLogs(token, { action, status, key, limit = 200 } = {}) {
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
    body: JSON.stringify({ name, role, ...(expiresInSeconds ? { expires_in_seconds: expiresInSeconds } : {}) }),
  });
}

export function revokeToken(token, name) {
  return apiFetch(`/api/tokens/${encodeURIComponent(name)}`, token, { method: "DELETE" });
}

export function rotateToken(token, name, customToken) {
  return apiFetch(`/api/tokens/${encodeURIComponent(name)}/rotate`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(customToken ? { token: customToken } : {}),
  });
}
