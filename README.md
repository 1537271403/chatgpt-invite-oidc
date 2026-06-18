# ChatGPT Invite OIDC

[中文文档](README.zh-CN.md) | [Cloudflare Workers 中文部署](workers/README.md)

Minimal self-hosted OIDC provider for ChatGPT/OpenAI SSO.

The recommended deployment is the Cloudflare Workers version in [`workers/`](workers/), but this repository also includes a Docker/FastAPI version.

## Features

- OIDC discovery endpoint
- RS256 signed ID tokens with persistent signing key
- Authorization code flow
- Single-use authorization codes
- `/userinfo` endpoint
- Multi-workspace admin UI at `/admin`
- Per-workspace Client ID / Client Secret
- Per-workspace invite code
- Per-workspace email domain allowlist
- Per-workspace redirect/callback/fallback URL allowlist
- Basic per-IP rate limiting on invite attempts
- Docker Compose deployment

## Docker quick deploy

```bash
git clone https://github.com/YOUR_USER/chatgpt-invite-oidc.git
cd chatgpt-invite-oidc
cp .env.example .env
nano .env

docker compose up -d --build
curl http://127.0.0.1:8090/healthz
```

## Required `.env` for Docker/FastAPI

```env
OIDC_ISSUER=https://oidc.example.com
ADMIN_PASSWORD=replace-with-a-long-random-admin-password
HOST_PORT=8090
```

Optional tuning:

```env
CODE_TTL_SECONDS=300
TOKEN_TTL_SECONDS=3600
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
DATA_DIR=/data
```

Legacy single-workspace fallback variables are still supported when no workspaces exist in `/admin`, but new deployments should manage workspaces in `/admin` instead:

```env
# OIDC_CLIENT_ID=chatgpt-sso
# OIDC_CLIENT_SECRET=replace-with-a-long-random-secret
# ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
# INVITE_CODE=replace-with-a-long-random-invite-code
# ALLOWED_EMAIL_DOMAINS=example.com,work.example
# FAMILY_NAME=Example
```

Generate secrets:

```bash
openssl rand -hex 32
```

## Admin UI

Open:

```text
https://oidc.example.com/admin
```

Basic Auth:

```text
Username: any value
Password: ADMIN_PASSWORD
```

Create one workspace per ChatGPT/OpenAI workspace. Each workspace has its own:

```text
Name
Client ID
Client Secret
Invite Code
Allowed Email Domains
Redirect / Callback / Fallback URLs
Family Name claim
Enabled flag
```

The OIDC flow selects the workspace by `client_id + redirect_uri`, so multiple ChatGPT workspaces can share one issuer safely.

## OpenAI / ChatGPT SSO config

Use the values from the matching `/admin` workspace:

```text
Client ID: workspace Client ID
Client Secret: workspace Client Secret
Discovery Endpoint: https://oidc.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

Add every OpenAI callback/fallback URL to that workspace's `Redirect / Callback / Fallback URLs` list.

## Nginx

Example config is in `nginx.example.conf`.

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

## Endpoints

- `GET /.well-known/openid-configuration`
- `GET /jwks`
- `GET /authorize`
- `POST /authorize`
- `POST /token`
- `GET /userinfo`
- `GET /healthz`
- `GET /admin`
- `POST /admin/save`
- `POST /admin/delete`

## Tests

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install fastapi pyjwt[crypto] cryptography python-multipart jinja2 pytest httpx
pytest -q
```

## Cloudflare Workers

A Cloudflare Workers version is available in [`workers/`](workers/). It uses Workers KV for workspace config, one-time authorization codes, rate limits, and automatic signing-key persistence, so it can run without a VPS, Docker, Nginx, or Certbot.

See [`workers/README.md`](workers/README.md).
