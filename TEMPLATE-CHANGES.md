# Recommended changes for `vps-service-template`

> These are recommendations for the **separate** repo
> `~/codes/personal/vps-service-template` (the shared deploy template every
> service repo copies). **Do not apply them here** — this file is the handoff.
> Nothing in this repo can enforce them; they must land in the template and in
> the vault's folder/token layout.

## Why this matters (the core problem)

The template's `deploy.yml` fetches `VPS_HOST` and `VPS_SSH_KEY` from this Secret
Manager using a **single global read token** (`SM_READ_TOKEN`) that is embedded
as a secret in **every** service repo. Two compounding issues:

1. **One token reads everything.** Until now a read token is unscoped — it can
   read every folder, including whatever folder holds the VPS SSH key.
2. **That token is copied into every repo.** So a leak from *any* single service
   repo (a careless log, a compromised Action, a fork) yields a credential that
   reads `VPS_SSH_KEY` → **root SSH on the VPS**. Blast radius = the whole box.

The Secret Manager now supports **per-folder token scope** (`scope` = a folder
list or `*`). The template and vault layout should use it to shrink that blast
radius to a single service.

## 1. Vault folder + token layout (operational, do in the Secret Manager)

- **Move `VPS_HOST` / `VPS_SSH_KEY` out of `Root` into a dedicated `Infra`
  folder.**
- Mint **`SM_INFRA_TOKEN`** scoped **only** to `Infra` (read). The org-level /
  reusable deploy job uses this token solely to fetch host + SSH key.
- Each service keeps its own secrets in its **own `<Service>` folder**, read by a
  token **scoped to that folder only** (e.g. `SM_SVC_<SERVICE>_TOKEN` → scope
  `["<Service>"]`).
- **Retire the shared global `SM_READ_TOKEN`.** No service repo should hold a
  token that can read `Infra` or any folder but its own. Net effect: a leaked
  per-service token can no longer read the SSH key or any other service's
  secrets.

Fetch example after the split (folder-scoped path already exists):
```
GET /api/secrets/Infra/VPS_SSH_KEY      # SM_INFRA_TOKEN only
GET /api/secrets/<Service>/<KEY>        # per-service token only
```

## 2. Split the deploy secret fetch in `deploy.yml`

- The step that reads `VPS_HOST` / `VPS_SSH_KEY` uses **`SM_INFRA_TOKEN`**.
- Application secrets for the service use the **per-service** token.
- Store `SM_INFRA_TOKEN` at the org/reusable-workflow level (not duplicated into
  every service repo); store each per-service token as that repo's own secret.

## 3. Switch auto-deploy to `workflow_dispatch` only

- The template currently triggers on `on: push`. The owner's stated policy is
  **`workflow_dispatch`-only** (manual, deliberate deploys).
- **Recommend:** remove the `push` trigger (or gate it behind an environment
  requiring approval) and rely on `workflow_dispatch`. An auto-deploy on every
  push to a public-VPS service that fronts CI is a foot-gun — a bad merge ships
  itself.

## 4. Harden the deploy-side secret fetch (`curl`)

The Secret Manager returns **JSON** on both success and error, including a JSON
`404` (`{"detail":"Secret not found"}`) and `429` on rate limit. A naive
`curl -sf ... | jq` is fragile against this:

- **`curl -f` turns 4xx/5xx into a silent non-zero exit with an empty body** —
  `jq` then chokes on empty input and the real cause (404 vs 429 vs auth) is
  lost. Capture the status separately, e.g.:
  ```bash
  resp=$(curl -sS -w '\n%{http_code}' \
    -H "Authorization: Bearer $SM_INFRA_TOKEN" \
    "$SM_URL/api/secrets/Infra/VPS_SSH_KEY")
  code=${resp##*$'\n'}; body=${resp%$'\n'*}
  [ "$code" = 200 ] || { echo "fetch failed ($code): $body" >&2; exit 1; }
  ```
- **Add retries** for transient 429/5xx / cold-start: `curl --retry 3
  --retry-connrefused --retry-delay 2` (and honor `Retry-After` if/when the
  server sends it). The public fetch route has its own rate limiter, so a burst
  of parallel deploys can legitimately get a `429`.
- Only the folder-scoped `GET /api/secrets/:folder/:key` is public. Do **not**
  point deploy scripts at `/api/exports` or the flat `/api/secrets/:key` route —
  the latter no longer exists.

## 5. Add a health check to the template's own compose

The template's service `compose` should carry a **node-native** health check
(same reason as this repo — `curl` is absent in `node:*-slim`):
```yaml
healthcheck:
  test: ["CMD","node","-e","fetch('http://127.0.0.1:PORT/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 15s
```
Adjust `PORT`/path per service. Pair it with `restart: unless-stopped` and a
`logging` json-file cap so a template-derived service can't silently wedge or
fill the disk.

---

### Summary of asks

| # | Change | Where |
|---|---|---|
| 1 | `Infra` folder + `SM_INFRA_TOKEN` (scope `Infra`); per-service folders + scoped tokens; retire global `SM_READ_TOKEN` | Secret Manager (vault data) |
| 2 | `deploy.yml` fetches host/key with `SM_INFRA_TOKEN`, app secrets with per-service token | template |
| 3 | Drop `on: push`, use `workflow_dispatch` (or approval-gated env) | template |
| 4 | Robust deploy `curl` — capture status, `--retry`, don't rely on `-f`+`jq` | template |
| 5 | Node-native health check + restart/logging caps in the service compose | template |
