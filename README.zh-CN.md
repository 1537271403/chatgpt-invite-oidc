# ChatGPT Invite OIDC 中文文档

这是一个给 ChatGPT / OpenAI SSO 使用的轻量 OIDC Provider。

支持两种部署方式：

| 部署方式 | 适合场景 | 配置保存位置 |
|---|---|---|
| **Cloudflare Workers** | 推荐；无需服务器 | Workers KV |
| **Docker / FastAPI** | VPS / 自托管服务器 | `/data/workspaces.json` |

两种部署现在使用同一套模型：

```text
一个 OIDC Issuer
多个 Workspace
/admin 管理后台
每个 Workspace 独立 Client ID / Client Secret
每个 Workspace 独立邀请码
每个 Workspace 独立邮箱域名白名单
每个 Workspace 独立 callback / fallback URL 白名单
```

> 安全模型：知道某个 Workspace 的邀请码，并输入该 Workspace 允许域名的邮箱，就可以声明自己是这个邮箱。邀请码要足够长，`/admin` 后台密码也要足够强。

---

## 1. 推荐部署：Cloudflare Workers

Workers 部署说明见：

```text
workers/README.md
```

### GitHub Secrets 必需

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
ADMIN_PASSWORD
```

### GitHub Variables 必需

```text
CF_WORKER_NAME
CF_KV_NAMESPACE_TITLE
OIDC_ISSUER
```

例如：

```text
CF_WORKER_NAME=chatgpt-invite-oidc
CF_KV_NAMESPACE_TITLE=chatgpt-invite-oidc-kv
OIDC_ISSUER=https://sso.example.com
```

部署后进入：

```text
https://你的-sso-域名/admin
```

在后台新增和管理 Workspace。

---

## 2. Docker / FastAPI 部署

### 快速启动

```bash
git clone https://github.com/YOUR_USER/chatgpt-invite-oidc.git
cd chatgpt-invite-oidc
cp .env.example .env
nano .env

docker compose up -d --build
curl http://127.0.0.1:8090/healthz
```

### Docker 必需 `.env`

```env
OIDC_ISSUER=https://oidc.example.com
ADMIN_PASSWORD=replace-with-a-long-random-admin-password
HOST_PORT=8090
```

生成 `ADMIN_PASSWORD`：

```bash
openssl rand -hex 32
```

### Docker 可选 `.env`

```env
CODE_TTL_SECONDS=300
TOKEN_TTL_SECONDS=3600
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_ATTEMPTS=10
DATA_DIR=/data
```

### 旧版单 Workspace fallback

如果 `/admin` 里还没有保存任何 Workspace，Docker/FastAPI 仍然可以读取旧版单 Workspace 变量：

```env
OIDC_CLIENT_ID=chatgpt-sso
OIDC_CLIENT_SECRET=replace-with-a-long-random-secret
ALLOWED_REDIRECT_URIS=https://external.auth.openai.com/sso/oidc/YOUR_CONNECTION_ID/callback
INVITE_CODE=replace-with-a-long-random-invite-code
ALLOWED_EMAIL_DOMAINS=example.com,work.example
FAMILY_NAME=Example
```

新部署建议直接用 `/admin`，不要再依赖这组旧变量。

---

## 3. 管理后台 `/admin`

打开：

```text
https://你的-sso-域名/admin
```

Basic Auth：

```text
Username: 任意值
Password: ADMIN_PASSWORD
```

每个 ChatGPT / OpenAI workspace 建一条 Workspace。

每条 Workspace 包含：

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

认证时按下面两个字段匹配 Workspace：

```text
client_id + redirect_uri
```

这样多个 ChatGPT Workspace 不会串用彼此的 callback URL、邮箱域名和秘钥。

---

## 4. OpenAI / ChatGPT SSO 配置

在 OpenAI / ChatGPT 对应 workspace 的 SSO 页面填写：

```text
Client ID: /admin 后台该 Workspace 的 Client ID
Client Secret: /admin 后台该 Workspace 的 Client Secret
Discovery Endpoint: https://你的-sso-域名/.well-known/openid-configuration
Scopes: openid email profile
```

OpenAI 给出的 callback / fallback URL 必须完整加入该 Workspace 的：

```text
Redirect / Callback / Fallback URLs
```

如果有多个 ChatGPT workspace，就在 `/admin` 里建多条 Workspace。

---

## 5. 端点

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

## 6. 数据持久化

### Workers

存储在 Workers KV：

```text
Workspace 配置
授权码
访问令牌
限速计数
JWT 签名私钥
```

### Docker / FastAPI

存储在 `DATA_DIR`，默认是 `/data`：

```text
/data/workspaces.json
/data/oidc_private_key.pem
```

如果要保留 Workspace 配置和签名私钥，不要删除 Docker volume。

---

## 7. 绑定自定义域名

### Workers

Cloudflare：

```text
Workers & Pages
→ chatgpt-invite-oidc
→ Settings
→ Domains & Routes
→ Add
→ Custom Domain
```

### Docker / FastAPI

可以用 `nginx.example.conf` 反代到本机 `HOST_PORT`。

验证：

```bash
curl https://你的-sso-域名/healthz
curl https://你的-sso-域名/.well-known/openid-configuration
curl https://你的-sso-域名/jwks
```

---

## 8. 常见问题

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

### endpoint unreachable

检查：

```bash
curl https://你的-sso-域名/.well-known/openid-configuration
curl https://你的-sso-域名/jwks
```

常见原因：

```text
OIDC_ISSUER 没有带 https://
域名没有绑定 Worker / 反代
DNS 没生效
Cloudflare Custom Domain 没配置
```

---

## 9. 测试

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install fastapi pyjwt[crypto] cryptography python-multipart jinja2 pytest httpx
pytest -q

cd workers
npm install
npm run check
```
