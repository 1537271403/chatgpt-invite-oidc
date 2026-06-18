# ChatGPT Invite OIDC

Minimal self-hosted OIDC provider for ChatGPT / OpenAI SSO.

It supports two deployment targets:

| Target | Recommended for | Config storage |
|---|---|---|
| **Cloudflare Workers** | Production / no server | Workers KV |
| **Docker / FastAPI** | VPS / self-hosted server | `/data/workspaces.json` |

Both targets now use the same model:

- One OIDC issuer
- Multiple workspaces
- `/admin` management UI
- Per-workspace Client ID / Client Secret
- Per-workspace invite code
- Per-workspace allowed email domains
- Per-workspace callback / fallback URL allowlist

> Security model: anyone who knows a workspace invite code and can enter an allowed-domain email can authenticate as that email. Use long invite codes and keep `/admin` protected.

---

## 1. Recommended deployment: Cloudflare Workers

For Workers deployment, use:

```text
workers/README.md
```

Required GitHub Secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD
```

Required GitHub Variables:

```text
CF_WORKER_NAME
CF_KV_NAMESPACE_TITLE
OIDC_ISSUER
```

After deployment, manage workspaces at:

```text
https://your-sso-domain/admin
```

---

## 2. Docker / FastAPI deployment

### Quick start

```bash
git clone https://github.com/YOUR_USER/chatgpt-invite-oidc.git
cd chatgpt-invite-oidc
cp .env.example .env
nano .env

docker compose up -d --build
curl http://127.0.0.1:8090/healthz
```

### Required `.env`

```env
OIDC_ISSUER=https://oidc.example.com
ADMIN_PASSWORD=replace-with-a-long-random-admin-password
HOST_PORT=8090
```

Generate `ADMIN_PASSWORD`:

```bash
openssl rand -hex 32
```

### Optional `.env`

```env
CODE_TTL_SECONDS=300
TOKEN_TTL_SECONDS=3600
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
DATA_DIR=/data
```

### Legacy single-workspace fallback

If no workspace has been saved in `/admin`, Docker/FastAPI can still read the old single-workspace environment variables:

```env
OIDC_CLIENT_ID=chatgpt-sso
OIDC_CLIENT_SECRET=replace-with-a-long-random-secret
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
INVITE_CODE=replace-with-a-long-random-invite-code
ALLOWED_EMAIL_DOMAINS=example.com,work.example
FAMILY_NAME=Example
```

New deployments should prefer `/admin` instead.

---

## 3. Admin UI

Open:

```text
https://your-sso-domain/admin
```

Basic Auth:

```text
Username: any value
Password: ADMIN_PASSWORD
```

Create one workspace per ChatGPT / OpenAI workspace.

Each workspace contains:

```text
Name
Client ID
Client Secret
Invite Code
Allowed Email Domains
Redirect / Callback / Fallback URLs
Family Name claim
Enabled
```

The OIDC flow selects a workspace by:

```text
client_id + redirect_uri
```

This prevents one OpenAI workspace from using another workspace's callback URL, email domain list, or secret.

---

## 4. OpenAI / ChatGPT SSO settings

In OpenAI / ChatGPT, use the values from the matching `/admin` workspace:

```text
Client ID: workspace Client ID
Client Secret: workspace Client Secret
Discovery Endpoint: https://your-sso-domain/.well-known/openid-configuration
Scopes: openid email profile
```

Add every OpenAI callback / fallback URL to that workspace:

```text
Redirect / Callback / Fallback URLs
```

---

## 5. Endpoints

```text
GET  /.well-known/openid-configuration
GET  /jwks
GET  /authorize
POST /authorize
POST /token
GET  /userinfo
GET  /healthz
GET  /admin
POST /admin/save
POST /admin/delete
```

---

## 6. Data persistence

### Workers

Stored in Workers KV:

```text
workspace config
authorization codes
access tokens
rate limit counters
signing key
```

### Docker / FastAPI

Stored under `DATA_DIR`, default `/data`:

```text
/data/workspaces.json
/data/oidc_private_key.pem
```

Keep the Docker volume if you want to preserve workspace config and signing keys.

---

## 7. Nginx for Docker / FastAPI

Example config:

```text
nginx.example.conf
```

Typical setup:

```bash
cp nginx.example.conf /etc/nginx/conf.d/oidc.example.com.conf
certbot certonly --nginx -d oidc.example.com
nginx -t && systemctl reload nginx
```

Verify externally:

```bash
curl https://oidc.example.com/.well-known/openid-configuration
curl https://oidc.example.com/jwks
```

---

## 8. Tests

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install fastapi pyjwt[crypto] cryptography python-multipart jinja2 pytest httpx
pytest -q

cd workers
npm install
npm run check
```
