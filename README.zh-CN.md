# ChatGPT Invite OIDC 中文部署文档

这是一个给 ChatGPT / OpenAI SSO 使用的极简 OIDC Provider。

它不保存用户数据库，不需要注册账号。用户登录时只需要输入：

```text
邮箱 + 邀请码
```

服务会校验：

```text
邮箱必须属于允许的域名
邀请码必须正确
```

然后把邮箱作为 OIDC claims 返回给 OpenAI / ChatGPT：

```json
{
  "sub": "alice@example.com",
  "email": "alice@example.com",
  "email_verified": true,
  "given_name": "alice",
  "family_name": "Example"
}
```

> 安全模型：知道邀请码，并且输入任意允许域名邮箱的人，就可以声明自己是这个邮箱。邀请码要足够长，泄露后及时轮换。

---

## 推荐部署方式：Cloudflare Workers + GitHub Actions

推荐用 Workers 版：

```text
不需要 VPS
不需要 Docker
不需要 Nginx
不需要 Certbot
Cloudflare 自动 HTTPS
GitHub Action 自动部署
自动创建 / 复用 Workers KV
自动写入 Worker Secrets
JWT 签名私钥自动生成并保存到 KV
```

Workers 代码在：

```text
workers/
```

Action 文件在：

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

资源范围：

```text
Account Resources: 你的账号
Zone Resources: 你的域名
```

同时找到 Cloudflare Account ID：

```text
Cloudflare Dashboard → 右侧 Account ID
```

---

## 2. 准备 OpenAI Callback URL

OpenAI / ChatGPT SSO 后台会给一个 Callback URL，类似：

```text
https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
```

这个值后面要填到 GitHub Variables：

```text
ALLOWED_REDIRECT_URIS
```

必须一字不差。

---

## 3. 生成 Client Secret 和邀请码

执行：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

建议：

```text
第一条 → OIDC_CLIENT_SECRET
第二条 → INVITE_CODE
```

说明：

```text
OIDC_CLIENT_SECRET = OpenAI 后台填写的 Client Secret
INVITE_CODE        = 用户登录页面输入的邀请码
```

---

## 4. 配置 GitHub Secrets

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

不需要添加：

```text
OIDC_PRIVATE_JWK
```

Worker 会第一次访问时自动生成 JWT 签名私钥，并持久化到 Workers KV。

---

## 5. 配置 GitHub Variables

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

示例：如果你的域名是 `sso.acidtech.asia`，邮箱域名是 `acidtech.asia`：

```text
OIDC_ISSUER=https://sso.acidtech.asia
ALLOWED_EMAIL_DOMAIN=acidtech.asia
FAMILY_NAME=AcidTech
```

可选 Variables：

```text
TOKEN_TTL_SECONDS=3600
CODE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
```

---

## 6. 运行 GitHub Action

进入：

```text
Actions → Deploy Cloudflare Workers → Run workflow
```

Action 会自动执行：

```text
npm ci
npm run check
创建 / 复用 Workers KV
生成 wrangler.toml
部署 Worker
写入 Worker Secrets
```

以后只要 push 到 `main` 并修改了 `workers/**`，也会自动部署。

---

## 7. 绑定自定义域名

进入 Cloudflare：

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

例如：

```text
sso.acidtech.asia
```

Cloudflare 会自动处理 HTTPS。

---

## 8. 验证接口

等待 1～3 分钟后访问：

```bash
curl https://sso.example.com/healthz
curl https://sso.example.com/.well-known/openid-configuration
curl https://sso.example.com/jwks
```

正常结果：

```json
{"ok":true}
```

Discovery 里应包含：

```json
{
  "issuer": "https://sso.example.com",
  "authorization_endpoint": "https://sso.example.com/authorize",
  "token_endpoint": "https://sso.example.com/token",
  "jwks_uri": "https://sso.example.com/jwks"
}
```

JWKS 应包含：

```json
{
  "keys": [
    {
      "kty": "RSA",
      "alg": "RS256",
      "n": "...",
      "e": "AQAB",
      "kid": "main",
      "use": "sig"
    }
  ]
}
```

---

## 9. OpenAI / ChatGPT SSO 配置

OpenAI 后台填写：

```text
Client ID:
chatgpt-sso
```

```text
Client Secret:
GitHub Secret 里的 OIDC_CLIENT_SECRET
```

```text
Discovery Endpoint:
https://sso.example.com/.well-known/openid-configuration
```

Scopes：

```text
openid email profile
```

对应关系：

```text
OpenAI Client ID     = GitHub Variable OIDC_CLIENT_ID
OpenAI Client Secret = GitHub Secret OIDC_CLIENT_SECRET
Discovery Endpoint   = OIDC_ISSUER + /.well-known/openid-configuration
```

---

## 10. 登录流程

用户在 ChatGPT 选择 SSO 后，会跳到 Worker 登录页。

输入：

```text
邮箱：alice@example.com
邀请码：INVITE_CODE
```

服务返回：

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

# 常见问题

## invalid_client_id

原因：

```text
OpenAI Client ID 和 OIDC_CLIENT_ID 不一致
```

修复：

```text
OpenAI Client ID = GitHub Variable OIDC_CLIENT_ID
```

默认：

```text
chatgpt-sso
```

---

## invalid_redirect_uri

原因：

```text
OpenAI callback URL 和 ALLOWED_REDIRECT_URIS 不一致
```

修复：

```text
ALLOWED_REDIRECT_URIS 必须完整等于 OpenAI 给的 callback URL
```

---

## Discovery endpoint unreachable

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

---

## jwks_uri unreachable or invalid

检查：

```bash
curl https://你的域名/jwks
```

必须返回：

```json
{"keys":[...]}
```

并且 key 包含：

```text
kty
n
e
kid
use
alg
```

---

## 修改变量后没生效

修改 GitHub Secrets / Variables 后，需要重新运行：

```text
Actions → Deploy Cloudflare Workers → Run workflow
```

---

## 换邀请码

修改 GitHub Secret：

```text
INVITE_CODE
```

然后重新 Run workflow。

---

## 换 Client Secret

修改 GitHub Secret：

```text
OIDC_CLIENT_SECRET
```

同时 OpenAI 后台的 Client Secret 也要改成同一串，然后重新 Run workflow。

---

# Docker Compose 部署

如果不用 Cloudflare Workers，也可以用 Docker Compose 部署。参考英文 README 的 Docker 部分：

```bash
git clone https://github.com/YOUR_USER/chatgpt-invite-oidc.git
cd chatgpt-invite-oidc
cp .env.example .env
nano .env
docker compose up -d --build
```

但推荐优先使用 Cloudflare Workers + GitHub Actions。