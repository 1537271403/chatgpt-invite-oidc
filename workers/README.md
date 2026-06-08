# Cloudflare Workers deploy

Cloudflare Workers version of the invite-code OIDC provider. It uses Workers KV for one-time authorization codes/rate limits and Wrangler secrets for sensitive values.

## 1. Install and login

```bash
cd workers
npm install
npx wrangler login
```

## 2. Configure

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create OIDC_KV
```

Paste the KV namespace id into `wrangler.toml`, then edit public vars:

```toml
OIDC_ISSUER = "https://sso.example.com"
OIDC_CLIENT_ID = "chatgpt-sso"
ALLOWED_REDIRECT_URIS = "https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback"
ALLOWED_EMAIL_DOMAIN = "example.com"
FAMILY_NAME = "Example"
```

## 3. Set secrets

Generate values:

```bash
openssl rand -hex 32 # OIDC_CLIENT_SECRET
openssl rand -hex 32 # INVITE_CODE
```

Set them:

```bash
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put INVITE_CODE
npx wrangler secret put ```

## 4. Deploy

```bash
npm run check
npx wrangler deploy
```

Attach your custom domain or route in Cloudflare, then verify:

```bash
curl https://sso.example.com/healthz
curl https://sso.example.com/.well-known/openid-configuration
curl https://sso.example.com/jwks
```

## OpenAI / ChatGPT SSO config

```text
Client ID: value of OIDC_CLIENT_ID
Client Secret: value of OIDC_CLIENT_SECRET
Discovery Endpoint: https://sso.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

OpenAI's callback URL must match `ALLOWED_REDIRECT_URIS` exactly.

## GitHub Actions deploy

This repo also includes `.github/workflows/deploy-workers.yml`.

Required GitHub **Secrets**:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
OIDC_CLIENT_SECRET
INVITE_CODE
```

Required GitHub **Variables**:

```text
CF_WORKER_NAME=chatgpt-invite-oidc
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=chatgpt-sso
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
ALLOWED_EMAIL_DOMAIN=example.com
FAMILY_NAME=Example
```

Optional GitHub **Variables**:

```text
# If omitted, the workflow creates/reuses KV namespace title: chatgpt-invite-oidc-kv
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
TOKEN_TTL_SECONDS=3600
CODE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
```

The GitHub Action automatically creates or reuses the Workers KV namespace by title, so you do **not** need to create KV manually. It also writes Worker runtime secrets from GitHub Secrets on every deploy, so first-time deployment can be fully completed from Actions.

Generate `OIDC_PRIVATE_JWK` locally once and save the full JSON as a GitHub Secret:

```bash
```

Every push to `main` that changes `workers/**` deploys automatically. You can also run the workflow manually from GitHub Actions.
