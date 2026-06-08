# Cloudflare Workers 部署

这是 invite-code OIDC Provider 的 Cloudflare Workers 版本。

推荐通过 GitHub Actions 部署：

```text
不需要 VPS
不需要 Docker
不需要 Nginx
不需要 Certbot
自动创建 / 复用 Workers KV
自动写入 Worker Secrets
JWT 签名私钥自动生成并保存到 KV
```

---

## 目录

```text
workers/
├── src/index.ts
├── package.json
├── wrangler.example.toml
└── README.md
```

Action 文件：

```text
.github/workflows/deploy-workers.yml
```

---

## 1. 准备 Cloudflare API Token

进入 Cloudflare：

```text
My Profile → API Tokens → Create Token
```

建议权限：

```text
Account → Workers Scripts → Edit
Account → Workers KV Storage → Edit
Account → Account Settings → Read
Zone → Zone → Read
Zone → Workers Routes → Edit
```

还需要 Cloudflare Account ID：

```text
Cloudflare Dashboard → Account ID
```

---

## 2. 配置 GitHub Secrets

进入 GitHub 仓库：

```text
Settings → Secrets and variables → Actions → Secrets
```

添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
OIDC_CLIENT_SECRET
INVITE_CODE
```

生成 `OIDC_CLIENT_SECRET` 和 `INVITE_CODE`：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

说明：

```text
OIDC_CLIENT_SECRET = OpenAI 后台填写的 Client Secret
INVITE_CODE        = 用户登录时输入的邀请码
```

不需要配置 `OIDC_PRIVATE_JWK`，Worker 会自动生成 JWT 签名私钥并保存到 KV。

---

## 3. 配置 GitHub Variables

进入：

```text
Settings → Secrets and variables → Actions → Variables
```

添加：

```text
CF_WORKER_NAME=chatgpt-invite-oidc
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=chatgpt-sso
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
ALLOWED_EMAIL_DOMAIN=example.com
FAMILY_NAME=Example
```

可选：

```text
TOKEN_TTL_SECONDS=3600
CODE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
```

---

## 4. 运行 Action

进入：

```text
Actions → Deploy Cloudflare Workers → Run workflow
```

Action 会自动：

```text
npm ci
npm run check
创建 / 复用 Workers KV
生成 wrangler.toml
部署 Worker
写入 Worker Secrets
```

以后 push 到 `main` 且修改 `workers/**` 时，会自动部署。

---

## 5. 绑定自定义域名

Cloudflare：

```text
Workers & Pages
→ chatgpt-invite-oidc
→ Settings
→ Domains & Routes
→ Add
→ Custom Domain
```

填写：

```text
sso.example.com
```

Cloudflare 会自动处理 HTTPS。

---

## 6. 验证

```bash
curl https://sso.example.com/healthz
curl https://sso.example.com/.well-known/openid-configuration
curl https://sso.example.com/jwks
```

正常：

```json
{"ok":true}
```

OpenAI Discovery Endpoint：

```text
https://sso.example.com/.well-known/openid-configuration
```

---

## 7. OpenAI / ChatGPT SSO 配置

```text
Client ID: value of OIDC_CLIENT_ID, default chatgpt-sso
Client Secret: value of OIDC_CLIENT_SECRET
Discovery Endpoint: https://sso.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

OpenAI 给的 callback URL 必须完整填到：

```text
ALLOWED_REDIRECT_URIS
```

---

# 本地 Wrangler 部署，可选

一般不需要。如果不用 GitHub Actions，可以手动：

```bash
cd workers
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler kv namespace create OIDC_KV
npm run check
npx wrangler secret put OIDC_CLIENT_SECRET
npx wrangler secret put INVITE_CODE
npx wrangler deploy
```

手动部署时需要把 KV namespace id 填入 `wrangler.toml`。