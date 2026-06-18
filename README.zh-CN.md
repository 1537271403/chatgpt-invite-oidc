# ChatGPT Invite OIDC 中文部署文档

这是一个给 ChatGPT / OpenAI SSO 使用的轻量 OIDC Provider。

当前推荐部署方式是：

```text
Cloudflare Workers + GitHub Actions + Workers KV
```

特点：

```text
不需要 VPS
不需要 Docker
不需要 Nginx
不需要 Certbot
Cloudflare 自动 HTTPS
GitHub Action 自动部署
JWT 签名私钥自动生成并保存到 KV
多 Workspace 配置通过 /admin 后台维护
```

---

## 当前必需变量 / 密钥清单

### GitHub Secrets 必需

进入：

```text
Settings → Secrets and variables → Actions → Secrets
```

保留 / 新增：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD
```

说明：

```text
CLOUDFLARE_API_TOKEN  = GitHub Actions 部署 Worker 用
CLOUDFLARE_ACCOUNT_ID = GitHub Actions 部署 Worker 用
ADMIN_PASSWORD        = 登录 /admin 管理后台用
```

生成 `ADMIN_PASSWORD`：

```bash
openssl rand -hex 32
```

### GitHub Variables 必需

进入：

```text
Settings → Secrets and variables → Actions → Variables
```

保留 / 新增：

```text
CF_WORKER_NAME=chatgpt-invite-oidc
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
OIDC_ISSUER=https://sso.example.com
```

`OIDC_ISSUER` 要换成你的 OIDC 域名，例如：

```text
OIDC_ISSUER=https://sso.acidtech.asia
```

### GitHub Variables 可选

没有设置时会使用默认值：

```text
TOKEN_TTL_SECONDS=3600
CODE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
```

### 可以删除的旧配置

这些已经迁移到 `/admin` 后台维护，不再需要作为 GitHub Secrets / Variables 存在：

```text
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
INVITE_CODE
ALLOWED_REDIRECT_URIS
ALLOWED_EMAIL_DOMAINS
ALLOWED_EMAIL_DOMAIN
FAMILY_NAME
ADMIN_EMAILS
ADMIN_INVITE_CODE
```

---

## Cloudflare API Token 权限

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

## 运行 GitHub Action

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

以后 push 到 `main` 且修改 `workers/**` 时，也会自动部署。

---

## 绑定自定义域名

Cloudflare：

```text
Workers & Pages
→ chatgpt-invite-oidc
→ Settings
→ Domains & Routes
→ Add
→ Custom Domain
```

填写你的 SSO 域名，例如：

```text
sso.example.com
sso.acidtech.asia
```

Cloudflare 会自动处理 HTTPS。

---

## 验证接口

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

## 管理后台

部署后打开：

```text
https://sso.example.com/admin
```

浏览器会弹出 Basic Auth：

```text
Username: 任意值
Password: ADMIN_PASSWORD
```

在后台为每个 ChatGPT workspace 新增一条 Workspace。

每条 Workspace 可以独立配置：

```text
Name
Client ID
Client Secret
Invite Code
Allowed Email Domains
Redirect / Callback / Fallback URLs
Family Name
Enabled
```

多个 workspace 不会串配置；认证时会按：

```text
client_id + redirect_uri
```

匹配对应 Workspace。

---

## OpenAI / ChatGPT SSO 配置

在 OpenAI / ChatGPT 对应 workspace 的 SSO 页面填写：

```text
Client ID: /admin 后台里该 Workspace 的 Client ID
Client Secret: /admin 后台里该 Workspace 的 Client Secret
Discovery Endpoint: https://sso.example.com/.well-known/openid-configuration
Scopes: openid email profile
```

OpenAI 给出的 callback / fallback URL 必须完整加入该 Workspace 的：

```text
Redirect / Callback / Fallback URLs
```

如果有多个 ChatGPT workspace，就在 `/admin` 里建多条 Workspace，每条分别填自己的：

```text
Client ID
Client Secret
允许邮箱域名
callback / fallback URLs
邀请码
名称
```

---

## 登录流程

用户在 ChatGPT 选择 SSO 后，会跳到 Worker 登录页。

输入：

```text
邮箱
邀请码
```

Worker 会检查：

```text
邮箱域名是否属于该 Workspace 的 Allowed Email Domains
邀请码是否等于该 Workspace 的 Invite Code
redirect_uri 是否属于该 Workspace 的 Redirect / Callback / Fallback URLs
```

通过后返回 OIDC claims，例如：

```json
{
  "sub": "alice@example.com",
  "email": "alice@example.com",
  "email_verified": true,
  "given_name": "alice",
  "family_name": "Example"
}
```

ChatGPT / OpenAI 根据 `email/sub` 识别账号。

---

## 常见问题

### invalid_client_id

原因：

```text
OpenAI 填写的 Client ID 不存在于 /admin 后台任何已启用 Workspace
```

修复：

```text
检查 /admin 后台对应 Workspace 的 Client ID
检查 Workspace 是否 Enabled
```

### invalid_redirect_uri

原因：

```text
OpenAI callback/fallback URL 没有加入该 Workspace 的 Redirect / Callback / Fallback URLs
```

修复：

```text
把 OpenAI 给出的 callback/fallback URL 原样加入 /admin 对应 Workspace
```

### invalid_client

原因：

```text
OpenAI 填写的 Client Secret 和 /admin 后台该 Workspace 的 Client Secret 不一致
```

修复：

```text
同步修改 OpenAI 后台和 /admin 后台的 Client Secret
```

### Discovery endpoint unreachable

检查：

```bash
curl https://你的域名/.well-known/openid-configuration
```

常见原因：

```text
域名没有绑定 Worker
DNS 没生效
Cloudflare Custom Domain 没配置
OIDC_ISSUER 填错
```

### 修改 Workspace 后没生效

Workspace 数据保存在 Workers KV。通常保存后会立即用于后续登录；如果 OpenAI 页面仍旧失败，优先检查：

```text
Client ID
Client Secret
Redirect / Callback / Fallback URLs
Allowed Email Domains
Workspace Enabled 状态
```

---

## 本地 Wrangler 部署，可选

一般不需要。如果不用 GitHub Actions，可以手动：

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

手动部署时需要把 KV namespace id 填入 `wrangler.toml`。

---

## Docker Compose 部署

如果不用 Cloudflare Workers，也可以用 Docker Compose 部署 FastAPI 版本。FastAPI 版本仍是传统单服务配置，主要参考英文 README 的 Docker 部分。

但当前推荐优先使用：

```text
Cloudflare Workers + /admin 多 Workspace 管理后台
```
