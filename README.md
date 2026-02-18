# Secret Manager

Lightweight self-hosted environment variable (secrets) manager for hobby/small internal use.

- Backend: Express.js
- Frontend: Vite + React
- Storage: SQLite
- Encryption at rest: AES-256-GCM (master key from environment)
- Auth: Bearer token or `X-API-Key`, token hashes stored in DB

## Folder Structure

```text
.
├── server
│   ├── package.json
│   └── src
│       ├── config.js
│       ├── crypto.js
│       ├── database.js
│       ├── index.js
│       ├── rate-limit.js
│       └── utils.js
├── frontend
│   ├── package.json
│   ├── vite.config.js
│   └── src
│       ├── App.jsx
│       ├── main.jsx
│       └── styles.css
├── data/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## Features

1. Encrypted secret storage in SQLite (`key`, encrypted `value`)
2. REST API (curl-friendly)
3. Token-based auth with hashed token storage
4. Web UI for login, list/add/edit/delete, masked values, clipboard copy
5. Per-IP rate limiting
6. Basic audit logging (no secret values logged)
7. Dockerized deployment
8. Bonus:
   - Export secrets as `.env`
   - Import `.env` content
   - Read vs write token roles

## Configuration

Required:

- `SECRET_MANAGER_MASTER_KEY`: long random secret used to derive AES key

Recommended bootstrap tokens:

- `SECRET_MANAGER_ADMIN_TOKEN`: write token
- `SECRET_MANAGER_READ_TOKEN`: read-only token

Optional:

- `SECRET_MANAGER_DB_PATH` (default: `data/secrets.db`)
- `SECRET_MANAGER_RATE_LIMIT_PER_MINUTE` (default: `120`)
- `SECRET_MANAGER_HOST` (default: `0.0.0.0`)
- `SECRET_MANAGER_PORT` (default: `8000`)

## Run Locally

Install deps:

```bash
cd server && npm install
cd ../frontend && npm install
```

Create local env file:

```bash
cp .env.example .env
```

Update `.env` with a real `SECRET_MANAGER_MASTER_KEY` and tokens.

Start backend:

```bash
cd server
npm run dev
```

Start frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open UI: `http://localhost:5173/secret-manager/`

## Docker

```bash
docker compose up --build -d
```

Open UI: `http://localhost:8000/secret-manager/`

## API Endpoints

All `/api/*` routes require auth:

- `Authorization: Bearer <token>`
- or `X-API-Key: <token>`

### List keys (no values)

```bash
curl -s -H "Authorization: Bearer admin-token-change-me" \
  http://localhost:8000/api/secrets
```

### Get decrypted value

```bash
curl -s -H "Authorization: Bearer admin-token-change-me" \
  http://localhost:8000/api/secrets/DATABASE_URL
```

### Add/update secret (write token)

```bash
curl -s -X POST http://localhost:8000/api/secrets \
  -H "Authorization: Bearer admin-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"key":"DATABASE_URL","value":"postgres://user:pass@db:5432/app"}'
```

### Delete secret (write token)

```bash
curl -s -X DELETE \
  -H "Authorization: Bearer admin-token-change-me" \
  http://localhost:8000/api/secrets/DATABASE_URL
```

### Export as `.env`

```bash
curl -s -H "Authorization: Bearer admin-token-change-me" \
  http://localhost:8000/api/secrets/export
```

### Import `.env` (write token)

```bash
cat > /tmp/import.env <<'EOT'
API_KEY="abc123"
REDIS_URL="redis://localhost:6379/0"
EOT

curl -s -X POST http://localhost:8000/api/secrets/import \
  -H "Authorization: Bearer admin-token-change-me" \
  -H "Content-Type: text/plain" \
  --data-binary @/tmp/import.env
```

## Security Notes

- Secret values are encrypted with AES-256-GCM before DB storage.
- API tokens are stored hashed (PBKDF2-SHA256) with per-token random salt.
- Never logs plaintext secret values.
- Audit table tracks action, key name, status, token name, and source IP.
- Includes per-IP rate limiting.
- Intended for deployment behind HTTPS reverse proxy (Nginx/Caddy/Traefik).
- Rotate tokens by changing env bootstrap tokens and restarting.
- Rotating master key invalidates decryption of existing secrets unless re-encrypted.

## Notes

- This project is intentionally minimal and not enterprise multi-tenant.
- For production hardening, add network restrictions, backups, and monitoring.
