# ChatGPT Invite OIDC

[中文文档](README.zh-CN.md) | [Cloudflare Workers 中文部署](workers/README.md)

Minimal self-hosted OIDC provider for ChatGPT/OpenAI SSO.

It does **not** keep a user database. Users enter:

- `@your-domain` email
- shared invite code

The service validates both and returns OIDC claims based on the email:

```json
{
  "sub": "alice@example.com",
  "email": "alice@example.com",
  "email_verified": true,
  "given_name": "alice",
  "family_name": "Example"
}
```

> Security model: anyone who knows the invite code and an allowed-domain email can authenticate as that email. Use a long invite code, rotate it if leaked, and restrict the email domain.

## Features

- OIDC discovery endpoint
- RS256 signed ID tokens with persistent key volume
- Authorization code flow
- Single-use authorization codes
- `/userinfo` endpoint
- Email-domain restriction
- Shared invite-code gate
- Basic per-IP rate limiting on invite attempts
- Docker Compose deployment

## Quick deploy

```bash
git clone https://github.com/YOUR_USER/chatgpt-invite-oidc.git
cd chatgpt-invite-oidc
cp .env.example .env
nano .env

docker compose up -d --build
curl http://127.0.0.1:8090/healthz
```

## Required `.env`

```env
OIDC_ISSUER=https://oidc.example.com
OIDC_CLIENT_ID=chatgpt-sso
OIDC_CLIENT_SECRET=replace-with-a-long-random-secret
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
INVITE_CODE=replace-with-a-long-random-invite-code
ALLOWED_EMAIL_DOMAINS=example.com,work.example
HOST_PORT=8090
```

Generate secrets:

```bash
openssl rand -hex 32
```

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

## OpenAI / ChatGPT SSO config

Use:

```text
Client ID: chatgpt-sso
Client Secret: value of OIDC_CLIENT_SECRET
Discovery Endpoint: https://oidc.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

The OpenAI callback URL must be listed exactly in `ALLOWED_REDIRECT_URIS`.
Use `ALLOWED_EMAIL_DOMAINS` as a comma-separated allowlist when multiple ChatGPT workspaces verify different email domains, for example `example.com,work.example`. The older single-domain `ALLOWED_EMAIL_DOMAIN` variable is still supported for existing deployments.

## Endpoints

- `GET /.well-known/openid-configuration`
- `GET /jwks`
- `GET /authorize`
- `POST /authorize`
- `POST /token`
- `GET /userinfo`
- `GET /healthz`

## Tests

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e . pytest httpx
pytest -q
```

## Rotate invite code

Edit `.env`:

```env
INVITE_CODE=new-long-code
```

Then restart:

```bash
docker compose up -d
```
## Cloudflare Workers

A Cloudflare Workers version is available in [`workers/`](workers/). It uses Workers KV for one-time authorization codes/rate limits, GitHub Actions for deployment, and automatic signing-key generation persisted in KV, so it can run without a VPS, Docker, Nginx, or Certbot.

See [`workers/README.md`](workers/README.md).
