# ChatGPT Invite OIDC

Minimal self-hosted OIDC provider for ChatGPT/OpenAI SSO.

It does **not** keep a user database. Users enter:

- `@your-domain` email
- shared invite code

The service validates both and returns OIDC claims based on the email:

```json
{
  "sub": "alice@acidtech.asia",
  "email": "alice@acidtech.asia",
  "email_verified": true,
  "given_name": "alice",
  "family_name": "AcidTech"
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
OIDC_ISSUER=https://oidc.acidtech.asia
OIDC_CLIENT_ID=chatgpt-sso
OIDC_CLIENT_SECRET=replace-with-a-long-random-secret
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
INVITE_CODE=replace-with-a-long-random-invite-code
ALLOWED_EMAIL_DOMAIN=acidtech.asia
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
cp nginx.example.conf /etc/nginx/conf.d/oidc.acidtech.asia.conf
certbot certonly --nginx -d oidc.acidtech.asia
nginx -t && systemctl reload nginx
```

Verify externally:

```bash
curl https://oidc.acidtech.asia/.well-known/openid-configuration
curl https://oidc.acidtech.asia/jwks
```

## OpenAI / ChatGPT SSO config

Use:

```text
Client ID: chatgpt-sso
Client Secret: value of OIDC_CLIENT_SECRET
Discovery Endpoint: https://oidc.acidtech.asia/.well-known/openid-configuration
Scopes: openid email profile
```

The OpenAI callback URL must be listed exactly in `ALLOWED_REDIRECT_URIS`.

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
