# Cloudflare Workers Deployment

This is the Cloudflare Workers version of ChatGPT Invite OIDC.

Use this version if you want:

```text
No VPS
No Docker
No Nginx
No Certbot
Automatic HTTPS through Cloudflare
Workspace config stored in Workers KV
Deployment through GitHub Actions
```

The Worker supports multiple ChatGPT / OpenAI workspaces through `/admin`.

---

## 1. Required GitHub Secrets

Repository path:

```text
Settings → Secrets and variables → Actions → Secrets
```

Create / keep:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD
```

Generate `ADMIN_PASSWORD`:

```bash
openssl rand -hex 32
```

Meaning:

```text
CLOUDFLARE_API_TOKEN  = deploy Worker from GitHub Actions
CLOUDFLARE_ACCOUNT_ID = deploy Worker from GitHub Actions
ADMIN_PASSWORD        = /admin Basic Auth password; username can be any value
```

Old secrets are no longer needed because workspace settings live in `/admin`:

```text
OIDC_CLIENT_SECRET
INVITE_CODE
ADMIN_EMAILS
ADMIN_INVITE_CODE
```

---

## 2. Required GitHub Variables

Repository path:

```text
Settings → Secrets and variables → Actions → Variables
```

Create / keep:

```text
CF_WORKER_NAME=chatgpt-invite-oidc
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
OIDC_ISSUER=https://sso.example.com
```

Important: `OIDC_ISSUER` must include `https://`.

Optional variables:

```text
TOKEN_TTL_SECONDS=3600
CODE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
```

Old variables are no longer needed:

```text
OIDC_CLIENT_ID
ALLOWED_REDIRECT_URIS
ALLOWED_EMAIL_DOMAINS
ALLOWED_EMAIL_DOMAIN
FAMILY_NAME
```

---

## 3. Cloudflare API Token permissions

Create a Cloudflare token at:

```text
My Profile → API Tokens → Create Token
```

Suggested permissions:

```text
Account → Workers Scripts → Edit
Account → Workers KV Storage → Edit
Account → Account Settings → Read
Zone → Zone → Read
Zone → Workers Routes → Edit
```

You also need the Cloudflare Account ID:

```text
Cloudflare Dashboard → Account ID
```

---

## 4. Deploy

Run manually:

```text
Actions → Deploy Cloudflare Workers → Run workflow
```

The Action will:

```text
npm ci
npm run check
create / reuse Workers KV
write wrangler.toml
deploy Worker
write Worker secrets
```

Future pushes to `main` that touch `workers/**` also deploy automatically.

---

## 5. Bind a custom domain

Cloudflare:

```text
Workers & Pages
→ chatgpt-invite-oidc
→ Settings
→ Domains & Routes
→ Add
→ Custom Domain
```

Example:

```text
sso.example.com
```

Then verify:

```bash
curl https://sso.example.com/healthz
curl https://sso.example.com/.well-known/openid-configuration
curl https://sso.example.com/jwks
```

---

## 6. Admin UI

Open:

```text
https://sso.example.com/admin
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

The Worker selects a workspace by:

```text
client_id + redirect_uri
```

This keeps multiple OpenAI workspaces isolated from each other.

---

## 7. OpenAI / ChatGPT SSO settings

Use values from the matching `/admin` workspace:

```text
Client ID: workspace Client ID
Client Secret: workspace Client Secret
Discovery Endpoint: https://sso.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

Add every OpenAI callback / fallback URL to that workspace:

```text
Redirect / Callback / Fallback URLs
```

---

## 8. Local Wrangler deployment, optional

Normally not needed. If you do not use GitHub Actions:

```bash
cd workers
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler kv namespace create OIDC_KV
npm run check
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

Fill the KV namespace id in `wrangler.toml` before deploying.

---

## 9. Troubleshooting

### Endpoints unreachable in OpenAI

Check discovery:

```bash
curl https://sso.example.com/.well-known/openid-configuration
```

Make sure the response contains full HTTPS URLs:

```json
{
  "issuer": "https://sso.example.com",
  "authorization_endpoint": "https://sso.example.com/authorize",
  "token_endpoint": "https://sso.example.com/token",
  "jwks_uri": "https://sso.example.com/jwks"
}
```

If the URLs look like `sso.example.com/authorize`, fix `OIDC_ISSUER` to include `https://` and redeploy.

### invalid_client_id

The Client ID entered in OpenAI does not match any enabled workspace in `/admin`.

### invalid_redirect_uri

The OpenAI callback / fallback URL was not added to that workspace's URL allowlist.

### invalid_client

The OpenAI Client Secret does not match the workspace Client Secret.

---

## 10. Current required checklist

Secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD
```

Variables:

```text
CF_WORKER_NAME
CF_KV_NAMESPACE_TITLE
OIDC_ISSUER
```

Everything else workspace-related is configured in `/admin`.
