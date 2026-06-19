export interface Env {
  OIDC_KV: KVNamespace;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_PRIVATE_JWK?: string;
  INVITE_CODE?: string;
  ALLOWED_REDIRECT_URIS?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAIL_DOMAIN?: string;
  FAMILY_NAME?: string;
  TOKEN_TTL_SECONDS?: string;
  CODE_TTL_SECONDS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_MAX_ATTEMPTS?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_EMAILS?: string;
  ADMIN_INVITE_CODE?: string;
}

type Workspace = {
  id: string;
  name: string;
  client_id: string;
  client_secret: string;
  invite_code: string;
  allowed_email_domains: string[];
  redirect_uris: string[];
  family_name: string;
  enabled: boolean;
};
type AuthCode = { email: string; redirect_uri: string; client_id: string; workspace_id: string; scope: string; nonce?: string };
type Claims = { sub: string; email: string; email_verified: true; given_name: string; family_name: string; name: string; preferred_username: string };

type JwkWithKid = JsonWebKey & { kid?: string };

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`Missing required configuration: ${name}`);
  return v;
}
function toInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function parseList(v: string | undefined): string[] {
  return (v || "").split(",").map((x) => x.trim()).filter(Boolean);
}
function parseDomains(v: string | undefined): string[] {
  return [...new Set(parseList(v).map((x) => x.toLowerCase().replace(/^@/, "")))];
}
function config(env: Env) {
  return {
    issuer: required(env.OIDC_ISSUER, "OIDC_ISSUER").replace(/\/$/, ""),
    privateJwk: env.OIDC_PRIVATE_JWK || "",
    tokenTtl: toInt(env.TOKEN_TTL_SECONDS, 3600),
    codeTtl: toInt(env.CODE_TTL_SECONDS, 300),
    rateWindow: toInt(env.RATE_LIMIT_WINDOW_SECONDS, 60),
    rateMax: toInt(env.RATE_LIMIT_MAX_ATTEMPTS, 10),
    adminPassword: env.ADMIN_PASSWORD || env.ADMIN_INVITE_CODE || "",
  };
}
function legacyWorkspace(env: Env): Workspace | undefined {
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET || !env.INVITE_CODE || !env.ALLOWED_REDIRECT_URIS) return undefined;
  const domains = parseDomains(env.ALLOWED_EMAIL_DOMAINS || env.ALLOWED_EMAIL_DOMAIN || "example.com");
  return {
    id: "default",
    name: "Default Workspace",
    client_id: env.OIDC_CLIENT_ID,
    client_secret: env.OIDC_CLIENT_SECRET,
    invite_code: env.INVITE_CODE,
    allowed_email_domains: domains.length ? domains : ["example.com"],
    redirect_uris: parseList(env.ALLOWED_REDIRECT_URIS),
    family_name: env.FAMILY_NAME || "Example",
    enabled: true,
  };
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64url(arr);
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function slug(s: string): string {
  const out = s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return out || `ws-${Date.now()}`;
}
function maskSecret(s: string): string {
  return s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "";
}
function basicAuth(request: Request): { id: string; secret: string } | undefined {
  const h = request.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("basic ")) return undefined;
  const raw = atob(h.slice(6));
  const i = raw.indexOf(":");
  return i >= 0 ? { id: raw.slice(0, i), secret: raw.slice(i + 1) } : undefined;
}
function adminUnauthorized(): Response {
  return new Response("admin authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="ChatGPT OIDC Admin"' } });
}
function requireAdmin(request: Request, env: Env): Response | undefined {
  const password = config(env).adminPassword;
  if (!password) return html("ADMIN_PASSWORD is not configured. Set it as a Worker secret to enable /admin.", 503);
  const auth = basicAuth(request);
  if (!auth || !safeEqual(auth.secret, password)) return adminUnauthorized();
  return undefined;
}

async function workspaceIds(env: Env): Promise<string[]> {
  const raw = await env.OIDC_KV.get("workspaces:list");
  return raw ? JSON.parse(raw) as string[] : [];
}
async function getStoredWorkspace(env: Env, id: string): Promise<Workspace | undefined> {
  const raw = await env.OIDC_KV.get(`workspace:${id}`);
  return raw ? JSON.parse(raw) as Workspace : undefined;
}
async function getWorkspaces(env: Env): Promise<Workspace[]> {
  const ids = await workspaceIds(env);
  const out: Workspace[] = [];
  for (const id of ids) {
    const ws = await getStoredWorkspace(env, id);
    if (ws) out.push(ws);
  }
  if (!out.length) {
    const legacy = legacyWorkspace(env);
    if (legacy) out.push(legacy);
  }
  return out;
}
async function findWorkspaceByClient(env: Env, clientId: string): Promise<Workspace | undefined> {
  return (await getWorkspaces(env)).find((ws) => ws.enabled && ws.client_id === clientId);
}
async function findWorkspaceById(env: Env, id: string): Promise<Workspace | undefined> {
  return (await getWorkspaces(env)).find((ws) => ws.id === id);
}
async function saveWorkspace(env: Env, ws: Workspace): Promise<void> {
  const id = slug(ws.id || ws.name || ws.client_id);
  ws.id = id;
  await env.OIDC_KV.put(`workspace:${id}`, JSON.stringify(ws));
  const ids = await workspaceIds(env);
  if (!ids.includes(id)) await env.OIDC_KV.put("workspaces:list", JSON.stringify([...ids, id]));
}
async function deleteWorkspace(env: Env, id: string): Promise<void> {
  await env.OIDC_KV.delete(`workspace:${id}`);
  const ids = (await workspaceIds(env)).filter((x) => x !== id);
  await env.OIDC_KV.put("workspaces:list", JSON.stringify(ids));
}
async function validateClient(env: Env, clientId: string, redirectUri: string): Promise<{ workspace?: Workspace; response?: Response }> {
  const ws = await findWorkspaceByClient(env, clientId);
  if (!ws) return { response: json({ error: "invalid_client_id" }, 400) };
  if (!ws.redirect_uris.includes(redirectUri)) return { response: json({ error: "invalid_redirect_uri" }, 400) };
  return { workspace: ws };
}
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
async function checkRateLimit(request: Request, env: Env): Promise<Response | undefined> {
  const c = config(env);
  const key = `rl:${clientIp(request)}:${Math.floor(Date.now() / 1000 / c.rateWindow)}`;
  const n = Number.parseInt((await env.OIDC_KV.get(key)) || "0", 10) || 0;
  if (n >= c.rateMax) return json({ error: "rate_limited" }, 429);
  await env.OIDC_KV.put(key, String(n + 1), { expirationTtl: c.rateWindow + 5 });
  return undefined;
}
function allowedDomainsText(ws: Workspace): string {
  return ws.allowed_email_domains.map((domain) => `@${domain}`).join(", ");
}
function emailDomainAllowed(ws: Workspace, email: string): boolean {
  return ws.allowed_email_domains.some((domain) => email.endsWith(`@${domain}`));
}
function validateInviteForEmail(ws: Workspace, email: string, inviteCode: string): string | undefined {
  if (!emailDomainAllowed(ws, email)) return `邮箱必须是以下域名之一 / Email must use one of: ${allowedDomainsText(ws)}`;
  if (!safeEqual(inviteCode, ws.invite_code)) return "邀请码不正确 / Invalid invite code";
  return undefined;
}
function claims(ws: Workspace, email: string): Claims {
  const local = email.split("@", 1)[0];
  return { sub: email, email, email_verified: true, given_name: local, family_name: ws.family_name || ws.name || "Workspace", name: local, preferred_username: local };
}
function loginPage(ws: Workspace, params: Record<string, string>, error = ""): Response {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const err = error ? `<div class="err">${esc(error)}</div>` : "";
  const placeholderDomain = ws.allowed_email_domains[0] || "example.com";
  const domainChips = ws.allowed_email_domains.map((domain) => `<span>@${esc(domain)}</span>`).join("");
  const domainsText = ws.allowed_email_domains.map((domain) => `@${domain}`).join(" / ") || "allowed domain";
  const initial = (ws.name.slice(0, 1) || "W").toUpperCase();
  return html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT SSO</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:#111827;background:#f6f7fb;display:grid;place-items:center;overflow:hidden}.bg{position:fixed;inset:0;background:radial-gradient(circle at 50% -12%,rgba(16,163,127,.20),transparent 34%),radial-gradient(circle at 86% 22%,rgba(99,102,241,.12),transparent 30%),linear-gradient(180deg,#fff 0%,#f4f7fb 100%)}.grain{position:fixed;inset:0;background-image:linear-gradient(rgba(15,23,42,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.55),transparent 75%)}.card{position:relative;width:min(92vw,430px);background:rgba(255,255,255,.86);backdrop-filter:blur(24px);border:1px solid rgba(221,228,239,.95);border-radius:30px;padding:30px;box-shadow:0 30px 90px rgba(24,39,68,.14),inset 0 1px 0 rgba(255,255,255,.95)}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}.brand{display:flex;align-items:center;gap:12px}.mark{width:44px;height:44px;border-radius:16px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center;box-shadow:0 14px 34px rgba(16,163,127,.22)}.mark svg{width:24px;height:24px;fill:#fff}.brand b{display:block;font-size:15px;letter-spacing:-.01em}.brand span{display:block;color:#7a8799;font-size:12px;margin-top:2px}.tag{font-size:12px;font-weight:800;color:#08745c;background:#edfdf7;border:1px solid #d6f6e9;border-radius:999px;padding:7px 10px}h1{margin:0 0 8px;font-size:30px;letter-spacing:-.05em;color:#0f172a}.sub{margin:0 0 24px;color:#66758a;font-size:14px}.wsbox{display:flex;align-items:center;gap:12px;background:#f8fafc;border:1px solid #e7edf5;border-radius:18px;padding:13px;margin-bottom:22px}.avatar{width:38px;height:38px;border-radius:14px;background:#111827;color:#fff;display:grid;place-items:center;font-weight:900}.wsbox b{display:block;font-size:14px}.wsbox span{display:block;font-size:12px;color:#78869a;margin-top:2px}.field{margin-top:14px}label{display:block;margin:0 0 7px;color:#344154;font-size:12px;font-weight:800}input{width:100%;height:54px;border:1px solid #dce4ef;border-radius:17px;background:#fff;color:#111827;padding:0 15px;font-size:15px;outline:none;transition:.18s}input:focus{border-color:#10a37f;box-shadow:0 0 0 4px rgba(16,163,127,.12)}.domains{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.domains span{font-size:12px;color:#526176;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:5px 8px}button{width:100%;height:54px;margin-top:24px;border:0;border-radius:17px;background:#101827;color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:0 18px 38px rgba(16,24,39,.18);transition:.18s}button:hover{transform:translateY(-1px);background:#0b1220}.err{background:#fff1f2;color:#be123c;border:1px solid #fecdd3;padding:10px 12px;border-radius:14px;margin:0 0 16px;font-size:13px}.footer{display:flex;justify-content:center;margin-top:18px;color:#8b98aa;font-size:12px}.footer span{display:inline-flex;gap:7px;align-items:center}.ok{width:7px;height:7px;border-radius:50%;background:#10a37f;box-shadow:0 0 0 5px rgba(16,163,127,.11)}@media(max-width:520px){body{overflow:auto}.card{border-radius:24px;padding:24px}.top{margin-bottom:22px}.tag{display:none}}
</style></head><body><div class="bg"></div><div class="grain"></div><main class="card"><div class="top"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24"><path d="M12 2.5c5.25 0 9.5 4.03 9.5 9s-4.25 9-9.5 9c-1.56 0-3.04-.36-4.34-1.01L3 20.5l1.18-4.3A8.57 8.57 0 0 1 2.5 11.5c0-4.97 4.25-9 9.5-9Z"/></svg></div><div><b>Invite OIDC</b><span>ChatGPT SSO</span></div></div><span class="tag">OIDC</span></div><h1>登录</h1><p class="sub">输入邮箱和邀请码继续。</p><div class="wsbox"><div class="avatar">${esc(initial)}</div><div><b>${esc(ws.name)}</b><span>${esc(domainsText)}</span></div></div>${err}<form method="post" action="/authorize">${hidden}<div class="field"><label>Email</label><input name="email" type="email" placeholder="you@${esc(placeholderDomain)}" required autofocus><div class="domains">${domainChips}</div></div><div class="field"><label>Invite code</label><input name="invite_code" type="password" placeholder="输入邀请码" required></div><button type="submit">Continue →</button></form><div class="footer"><span><i class="ok"></i>Secure OIDC sign-in</span></div></main></body></html>`);
}
function adminShell(body: string): Response {
  return html(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OIDC Admin</title><script>try{const t=localStorage.getItem('oidc-admin-theme')||((matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark');document.documentElement.dataset.theme=t;}catch{}</script><style>
:root{color-scheme:dark;--bg:#08090a;--page1:#08090a;--page2:#090a0d;--panel:#0f1011;--side:rgba(15,16,17,.74);--surface:rgba(255,255,255,.025);--surface2:rgba(255,255,255,.045);--surface3:rgba(255,255,255,.065);--border:rgba(255,255,255,.075);--border2:rgba(255,255,255,.13);--text:#f7f8f8;--muted:#8a8f98;--muted2:#62666d;--soft:#d0d6e0;--code:#d0d6e0;--accent:#5e6ad2;--accent2:#7170ff;--green:#27a644;--red:#ef4444;--shadow:0 18px 50px rgba(0,0,0,.18);--input:rgba(255,255,255,.022);--focus:rgba(113,112,255,.15)}:root[data-theme="light"]{color-scheme:light;--bg:#f7f8fb;--page1:#fbfbfd;--page2:#f1f3f7;--panel:#ffffff;--side:rgba(255,255,255,.78);--surface:#ffffff;--surface2:#f6f7fa;--surface3:#eef1f7;--border:rgba(15,23,42,.10);--border2:rgba(15,23,42,.16);--text:#111318;--muted:#687083;--muted2:#8a93a5;--soft:#303746;--code:#1f2937;--accent:#5e6ad2;--accent2:#4f46e5;--green:#16833a;--red:#dc2626;--shadow:0 18px 46px rgba(15,23,42,.08);--input:#ffffff;--focus:rgba(94,106,210,.16)}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:linear-gradient(180deg,var(--page1),var(--page2) 58%,var(--bg));color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Arial,sans-serif;font-size:14px;letter-spacing:-.012em;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"kern"}.app{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--border);background:var(--side);backdrop-filter:blur(18px);padding:22px 16px}.brand{display:flex;align-items:center;gap:10px;padding:6px 8px;margin-bottom:28px}.mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#8585ff,#5e6ad2);box-shadow:0 0 26px rgba(113,112,255,.32)}.brand strong{font-size:14px;font-weight:700;letter-spacing:-.2px}.brand span{display:block;color:var(--muted2);font-size:12px;margin-top:2px}.nav{display:grid;gap:4px}.nav a{display:flex;align-items:center;gap:9px;color:var(--soft);text-decoration:none;font-size:13px;font-weight:560;border-radius:8px;padding:9px 10px;border:1px solid transparent}.nav a.active,.nav a:hover{background:var(--surface2);border-color:var(--border);color:var(--text)}.side-foot{position:absolute;left:16px;right:16px;bottom:18px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--muted);font-size:12px;line-height:1.5;box-shadow:var(--shadow)}.main{min-width:0;padding:30px 34px 42px}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:26px}.kicker{color:var(--muted2);font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;margin-bottom:9px}.topbar h1{font-size:44px;line-height:.96;letter-spacing:-1.8px;font-weight:700;margin:0 0 10px}.topbar p{margin:0;color:var(--muted);font-size:15px;line-height:1.65;max-width:650px}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.search{min-width:240px;border-radius:999px;padding:8px 12px 8px 34px;background:var(--input);background-image:linear-gradient(transparent,transparent);position:relative}.search-wrap{position:relative}.search-wrap:before{content:"⌕";position:absolute;left:13px;top:50%;transform:translateY(-54%);color:var(--muted2);z-index:1;font-size:15px}.toast{position:fixed;right:22px;bottom:22px;z-index:20;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--panel);color:var(--text);box-shadow:var(--shadow);opacity:0;transform:translateY(8px) scale(.98);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.toast.show{opacity:1;transform:translateY(0) scale(1)}a.button,button{appearance:none;text-decoration:none;border:1px solid var(--border);background:var(--surface2);color:var(--soft);border-radius:8px;padding:8px 12px;font:inherit;font-size:13px;font-weight:560;cursor:pointer;line-height:1.2;transition:background .15s,border-color .15s,color .15s,transform .15s,box-shadow .15s}a.button:hover,button:hover{background:var(--surface3);border-color:var(--border2);color:var(--text);transform:translateY(-1px)}.primary{background:var(--accent)!important;border-color:rgba(255,255,255,.12)!important;color:white!important;box-shadow:0 10px 24px rgba(94,106,210,.22)}.danger{color:#fecaca!important;background:rgba(239,68,68,.12)!important;border-color:rgba(239,68,68,.25)!important}:root[data-theme="light"] .danger{color:#991b1b!important}.theme-toggle{min-width:88px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 396px;gap:18px;align-items:start}.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow),inset 0 1px 0 rgba(255,255,255,.04)}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border)}.panel-title{font-size:15px;font-weight:700;letter-spacing:-.22px}.count{color:var(--muted2);font-size:12px}.discovery{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;margin-bottom:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}.label{color:var(--muted2);font-size:11px;font-weight:650;margin-bottom:5px;letter-spacing:.025em}.mono{font-family:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;letter-spacing:-.02em}.workspace-list{display:grid;gap:12px;padding:14px}.ws{display:grid;gap:13px;padding:15px;border:1px solid var(--border);border-radius:12px;background:var(--surface);min-width:0;animation:rise .28s ease both}.ws.hide{display:none}@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.ws:hover{background:var(--surface2)}.ws-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}.name{min-width:0}.name h2{font-size:15px;line-height:1.32;font-weight:700;letter-spacing:-.24px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{font-size:12px;color:var(--muted2)}.meta-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;min-width:0}.meta-item{min-width:0}.code{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--code);background:var(--input);border:1px solid var(--border);border-radius:7px;padding:6px 7px;font-size:11.5px;line-height:1.45}.chips{display:flex;gap:6px;flex-wrap:wrap;min-width:0}.chip{border:1px solid var(--border);background:var(--surface2);color:var(--soft);border-radius:999px;padding:4px 7px;font-size:11px;font-weight:560}.status{display:inline-flex;align-items:center;gap:7px;color:#b8f3c3;font-size:12px;font-weight:560;white-space:nowrap}:root[data-theme="light"] .status{color:#166534}.status.off{color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px rgba(39,166,68,.55)}.off .dot{background:var(--muted2);box-shadow:none}.row-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.tiny{padding:6px 8px;font-size:12px}.urls{display:grid;gap:6px;min-width:0}.url-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;min-width:0}.empty{padding:30px;text-align:center;color:var(--muted)}.form{position:sticky;top:18px;padding:18px}.form h2{margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:-.55px}.hint{color:var(--muted);font-size:12.5px;line-height:1.55;margin-bottom:12px}.field{display:grid;gap:7px;margin-top:12px}label{font-size:12px;color:var(--soft);font-weight:560}input,textarea{width:100%;border:1px solid var(--border);background:var(--input);color:var(--text);border-radius:8px;padding:9px 10px;font:inherit;font-size:13px;outline:none}input::placeholder,textarea::placeholder{color:var(--muted2)}input:focus,textarea:focus{border-color:rgba(113,112,255,.62);box-shadow:0 0 0 3px var(--focus)}textarea{resize:vertical;min-height:82px}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.checkline{display:flex;align-items:center;gap:9px;margin-top:18px}.checkline input{width:16px;height:16px}.save{width:100%;margin-top:16px;padding:10px 12px}.copy{white-space:nowrap}.mobile-brand{display:none}@media(max-width:1060px){.app{grid-template-columns:1fr}.side{display:none}.main{padding:22px 16px}.mobile-brand{display:block;color:var(--muted);font-size:12px;margin-bottom:12px}.layout{grid-template-columns:1fr}.form{position:relative;top:auto}.row-actions{justify-content:flex-start}.topbar{display:block}.actions{justify-content:flex-start;margin-top:14px}}@media(max-width:560px){.topbar h1{font-size:32px}.two,.meta-grid{grid-template-columns:1fr}.main{padding:18px 12px}.panel-head{padding-left:14px;padding-right:14px}.workspace-list{padding:10px}.ws-top{display:grid}.code{white-space:normal;word-break:break-all}}
</style></head><body><div class="app"><aside class="side"><div class="brand"><div class="mark"></div><div><strong>ChatGPT SSO</strong><span>OIDC Admin</span></div></div><nav class="nav"><a class="active" href="/admin">Workspaces</a><a href="/.well-known/openid-configuration">Discovery</a><a href="/healthz">Health</a></nav><div class="side-foot">Minimal admin surface for workspace credentials, domains, and callback URLs.</div></aside><main class="main"><div class="mobile-brand">ChatGPT SSO · OIDC Admin</div><section class="topbar"><div><div class="kicker">ADMIN CONSOLE</div><h1>Workspaces</h1><p>Configure OpenID clients without visual noise. Credentials stay masked; operational values are one click away.</p></div><div class="toolbar"><label class="search-wrap"><input class="search" data-search placeholder="Search workspaces"></label><button type="button" class="theme-toggle" data-theme-toggle>Light</button><a class="button" href="/.well-known/openid-configuration">Discovery</a><a class="button primary" href="/admin">New workspace</a></div></section>${body}</main></div><script>
const toast=document.createElement('div');toast.className='toast';document.body.appendChild(toast);function showToast(m){toast.textContent=m;toast.classList.add('show');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>toast.classList.remove('show'),1300)}function applyTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('oidc-admin-theme',t)}catch{}document.querySelectorAll('[data-theme-toggle]').forEach(b=>b.textContent=t==='dark'?'Light':'Dark')}applyTheme(document.documentElement.dataset.theme||'dark');function copyText(v){navigator.clipboard?.writeText(v).then(()=>showToast('Copied')).catch(()=>showToast('Copy failed'));}function filterWorkspaces(q){q=(q||'').trim().toLowerCase();document.querySelectorAll('[data-workspace]').forEach(card=>{card.classList.toggle('hide',q&&!card.dataset.search.includes(q));});}document.addEventListener('input',e=>{const s=e.target.closest('[data-search]');if(s)filterWorkspaces(s.value)});document.addEventListener('click',e=>{const t=e.target.closest('[data-theme-toggle]');if(t){applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');showToast(document.documentElement.dataset.theme==='dark'?'Dark mode':'Light mode');return}const reveal=e.target.closest('[data-reveal]');if(reveal){const code=document.querySelector('[data-secret-value="'+CSS.escape(reveal.dataset.reveal||'')+'"]');if(code){const shown=code.dataset.shown==='1';code.textContent=shown?code.dataset.masked:code.dataset.full;code.dataset.shown=shown?'0':'1';reveal.textContent=shown?'Reveal':'Hide';showToast(shown?'Secret hidden':'Secret revealed')}return}const b=e.target.closest('[data-copy]');if(!b)return;copyText(b.getAttribute('data-copy')||'');const old=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=old,850);});
</script></body></html>`);
}

async function adminPage(env: Env, editId = ""): Promise<Response> {
  const workspaces = await getWorkspaces(env);
  const edit = editId ? await findWorkspaceById(env, editId) : undefined;
  const ws = edit || { id: "", name: "", client_id: "", client_secret: randomToken(24), invite_code: randomToken(18), allowed_email_domains: [], redirect_uris: [], family_name: "Example", enabled: true } as Workspace;
  const list = workspaces.map((w) => {
    const status = w.enabled ? `<span class="status"><span class="dot"></span>Enabled</span>` : `<span class="status off"><span class="dot"></span>Disabled</span>`;
    const domainChips = w.allowed_email_domains.map((d) => `<span class="chip">@${esc(d)}</span>`).join("") || `<span class="sub">No domains</span>`;
    const urls = w.redirect_uris.map((u) => `<div class="url-line"><span class="code mono">${esc(u)}</span><button type="button" class="tiny copy" data-copy="${esc(u)}">Copy</button></div>`).join("") || `<span class="sub">No redirect URLs</span>`;
    return `<article class="ws" data-workspace data-search="${esc([w.name,w.id,w.client_id,...w.allowed_email_domains,...w.redirect_uris].join(" ").toLowerCase())}"><div class="ws-top"><div class="name"><h2>${esc(w.name)}</h2><div class="sub mono">${esc(w.id)}</div></div><div>${status}</div></div><div class="meta-grid"><div class="meta-item"><div class="label">Client ID</div><span class="code mono" title="${esc(w.client_id)}">${esc(w.client_id)}</span></div><div class="meta-item"><div class="label">Secret</div><span class="code mono" data-secret-value="${esc(w.id)}" data-masked="${esc(maskSecret(w.client_secret))}" data-full="${esc(w.client_secret)}" data-shown="0">${esc(maskSecret(w.client_secret))}</span></div><div class="meta-item"><div class="label">Domains</div><div class="chips">${domainChips}</div></div><div class="meta-item"><div class="label">Actions</div><div class="row-actions"><button type="button" class="tiny copy" data-copy="${esc(w.client_id)}">Copy ID</button><button type="button" class="tiny" data-reveal="${esc(w.id)}">Reveal</button><a class="button tiny" href="/admin?edit=${encodeURIComponent(w.id)}">Edit</a><form method="post" action="/admin/delete" onsubmit="return confirm('Delete workspace?')"><input type="hidden" name="id" value="${esc(w.id)}"><button class="tiny danger">Delete</button></form></div></div></div><div class="urls"><div class="label">Redirect / Fallback URLs</div>${urls}</div></article>`;
  }).join("") || `<div class="empty">No workspaces yet. Create the first one from the form.</div>`;
  const form = `<section class="panel form"><h2>${edit ? "Edit workspace" : "New workspace"}</h2><div class="hint">Use clear IDs and keep generated secrets unless rotating credentials.</div><form method="post" action="/admin/save"><input type="hidden" name="original_id" value="${esc(edit?.id || "")}"><div class="two"><div class="field"><label>ID</label><input name="id" value="${esc(ws.id)}" placeholder="acidtech"></div><div class="field"><label>Name</label><input name="name" value="${esc(ws.name)}" placeholder="AcidTech Workspace" required></div></div><div class="field"><label>Client ID</label><input name="client_id" value="${esc(ws.client_id)}" placeholder="chatgpt-sso-acidtech" required></div><div class="field"><label>Client Secret</label><input name="client_secret" value="${esc(ws.client_secret)}" required></div><div class="field"><label>Invite Code</label><input name="invite_code" value="${esc(ws.invite_code)}" required></div><div class="field"><label>Allowed Email Domains</label><textarea name="allowed_email_domains" rows="3" placeholder="acidtech.asia&#10;153.ink" required>${esc(ws.allowed_email_domains.join("\n"))}</textarea></div><div class="field"><label>Redirect / Callback / Fallback URLs</label><textarea name="redirect_uris" rows="5" placeholder="https://external.auth.openai.com/sso/oidc/.../callback" required>${esc(ws.redirect_uris.join("\n"))}</textarea></div><div class="two"><div class="field"><label>Family Name claim</label><input name="family_name" value="${esc(ws.family_name)}"></div><label class="checkline"><input type="checkbox" name="enabled" ${ws.enabled ? "checked" : ""}> Enabled</label></div><button class="primary save">Save workspace</button>${edit ? ` <a class="button" style="display:block;text-align:center;margin-top:8px" href="/admin">Cancel edit</a>` : ""}</form></section>`;
  return adminShell(`<div class="discovery"><div><div class="label">Discovery URL</div><span class="mono code">${esc(config(env).issuer)}/.well-known/openid-configuration</span></div><button type="button" class="copy" data-copy="${esc(config(env).issuer)}/.well-known/openid-configuration">Copy</button></div><div class="layout"><section class="panel"><div class="panel-head"><div class="panel-title">Configured workspaces</div><div class="count">${workspaces.length} total</div></div><div class="workspace-list">${list}</div></section>${form}</div>`);
}

function formText(form: FormData, name: string): string {
  return String(form.get(name) || "").trim();
}
function textareaList(v: string): string[] {
  return [...new Set(v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];
}
async function adminSave(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const originalId = formText(form, "original_id");
  const id = slug(formText(form, "id") || formText(form, "name") || formText(form, "client_id"));
  const ws: Workspace = {
    id,
    name: formText(form, "name"),
    client_id: formText(form, "client_id"),
    client_secret: formText(form, "client_secret"),
    invite_code: formText(form, "invite_code"),
    allowed_email_domains: parseDomains(textareaList(formText(form, "allowed_email_domains")).join(",")),
    redirect_uris: textareaList(formText(form, "redirect_uris")),
    family_name: formText(form, "family_name") || "Example",
    enabled: form.get("enabled") === "on",
  };
  if (originalId && originalId !== id) await deleteWorkspace(env, originalId);
  await saveWorkspace(env, ws);
  return Response.redirect(new URL("/admin", request.url).toString(), 302);
}
async function adminDelete(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  await deleteWorkspace(env, formText(form, "id"));
  return Response.redirect(new URL("/admin", request.url).toString(), 302);
}

async function generatePrivateJwk(): Promise<JwkWithKid> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JwkWithKid;
  jwk.kid = jwk.kid || "main"; jwk.alg = "RS256"; jwk.key_ops = ["sign"]; jwk.ext = true;
  return jwk;
}
async function getPrivateJwk(env: Env): Promise<JwkWithKid> {
  const configured = config(env).privateJwk;
  if (configured) return JSON.parse(configured) as JwkWithKid;
  const key = "config:oidc_private_jwk";
  const existing = await env.OIDC_KV.get(key);
  if (existing) return JSON.parse(existing) as JwkWithKid;
  const jwk = await generatePrivateJwk();
  await env.OIDC_KV.put(key, JSON.stringify(jwk));
  return jwk;
}
async function publicJwk(env: Env): Promise<JwkWithKid> {
  const jwk = { ...(await getPrivateJwk(env)) } as JwkWithKid;
  delete jwk.d; delete jwk.p; delete jwk.q; delete jwk.dp; delete jwk.dq; delete jwk.qi; delete jwk.key_ops; delete jwk.ext;
  jwk.use = "sig"; jwk.alg = "RS256"; jwk.kid = jwk.kid || "main";
  return jwk;
}
async function signJwt(env: Env, payload: Record<string, unknown>): Promise<string> {
  const privateJwk = await getPrivateJwk(env);
  privateJwk.alg = "RS256"; privateJwk.key_ops = ["sign"]; privateJwk.ext = true;
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = { alg: "RS256", typ: "JWT", kid: privateJwk.kid || "main" };
  const enc = new TextEncoder();
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname.startsWith("/admin")) {
        const denied = requireAdmin(request, env);
        if (denied) return denied;
        if (url.pathname === "/admin" && request.method === "GET") return adminPage(env, url.searchParams.get("edit") || "");
        if (url.pathname === "/admin/save" && request.method === "POST") return adminSave(request, env);
        if (url.pathname === "/admin/delete" && request.method === "POST") return adminDelete(request, env);
        return json({ error: "not_found" }, 404);
      }
      if (url.pathname === "/.well-known/openid-configuration") {
        const c = config(env);
        return json({ issuer: c.issuer, authorization_endpoint: `${c.issuer}/authorize`, token_endpoint: `${c.issuer}/token`, userinfo_endpoint: `${c.issuer}/userinfo`, jwks_uri: `${c.issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid", "email", "profile"], claims_supported: ["sub", "email", "email_verified", "given_name", "family_name", "name", "preferred_username"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] });
      }
      if (url.pathname === "/jwks") return json({ keys: [await publicJwk(env)] });
      if (url.pathname === "/authorize" && request.method === "GET") {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => { params[key] = value; });
        const checked = await validateClient(env, params.client_id || "", params.redirect_uri || "");
        if (checked.response) return checked.response;
        if (params.response_type !== "code") return json({ error: "unsupported_response_type" }, 400);
        return loginPage(checked.workspace!, params);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const limited = await checkRateLimit(request, env);
        if (limited) return limited;
        const form = await request.formData();
        const params: Record<string, string> = {};
        form.forEach((value, key) => { params[key] = String(value); });
        const checked = await validateClient(env, params.client_id || "", params.redirect_uri || "");
        if (checked.response) return checked.response;
        const ws = checked.workspace!;
        const keep = { client_id: params.client_id || "", redirect_uri: params.redirect_uri || "", response_type: params.response_type || "", scope: params.scope || "", state: params.state || "", nonce: params.nonce || "" };
        const email = (params.email || "").trim().toLowerCase();
        const inviteError = validateInviteForEmail(ws, email, params.invite_code || "");
        if (inviteError) return loginPage(ws, keep, inviteError);
        if (params.response_type !== "code") return json({ error: "unsupported_response_type" }, 400);
        const code = randomToken();
        const data: AuthCode = { email, redirect_uri: params.redirect_uri, client_id: params.client_id, workspace_id: ws.id, scope: params.scope || "openid email profile", nonce: params.nonce || undefined };
        await env.OIDC_KV.put(`code:${code}`, JSON.stringify(data), { expirationTtl: config(env).codeTtl });
        const redirect = new URL(params.redirect_uri);
        redirect.searchParams.set("code", code);
        if (params.state) redirect.searchParams.set("state", params.state);
        return Response.redirect(redirect.toString(), 302);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = await request.formData();
        let clientId = String(form.get("client_id") || "");
        let clientSecret = String(form.get("client_secret") || "");
        const basic = basicAuth(request);
        if (basic) { clientId = basic.id; clientSecret = basic.secret; }
        const ws = await findWorkspaceByClient(env, clientId);
        if (!ws || !safeEqual(clientSecret, ws.client_secret)) return json({ error: "invalid_client" }, 401);
        if (String(form.get("grant_type") || "") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
        const code = String(form.get("code") || "");
        const raw = await env.OIDC_KV.get(`code:${code}`);
        if (!raw) return json({ error: "invalid_code" }, 400);
        await env.OIDC_KV.delete(`code:${code}`);
        const data = JSON.parse(raw) as AuthCode;
        if (data.client_id !== clientId || data.workspace_id !== ws.id || data.redirect_uri !== String(form.get("redirect_uri") || "")) return json({ error: "invalid_grant" }, 400);
        const now = Math.floor(Date.now() / 1000);
        const userClaims = claims(ws, data.email);
        const c = config(env);
        const idPayload: Record<string, unknown> = { iss: c.issuer, aud: ws.client_id, iat: now, exp: now + c.tokenTtl, ...userClaims };
        if (data.nonce) idPayload.nonce = data.nonce;
        const accessToken = randomToken();
        await env.OIDC_KV.put(`access:${accessToken}`, JSON.stringify(userClaims), { expirationTtl: c.tokenTtl });
        return json({ access_token: accessToken, token_type: "Bearer", expires_in: c.tokenTtl, id_token: await signJwt(env, idPayload), scope: data.scope });
      }
      if (url.pathname === "/userinfo") {
        const auth = request.headers.get("authorization") || "";
        const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
        const raw = token ? await env.OIDC_KV.get(`access:${token}`) : null;
        return raw ? json(JSON.parse(raw)) : json({ error: "invalid_token" }, 401);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "server_error", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};
