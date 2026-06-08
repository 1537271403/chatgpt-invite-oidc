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
node -e 'crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]).then(k=>crypto.subtle.exportKey("jwk",k.privateKey)).then(j=>{j.kid="main"; console.log(JSON.stringify(j))})'
```

Set them:

```bash
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put INVITE_CODE
npx wrangler secret put OIDC_PRIVATE_JWK
```

Paste the private JWK JSON when setting `OIDC_PRIVATE_JWK`.

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
