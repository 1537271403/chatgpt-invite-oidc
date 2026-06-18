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
function adminShell(body: string, env?: Env): Response {
  const issuer = env ? esc(config(env).issuer) : "";
  return html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OIDC Admin</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:#172033;background:#f5f7fb}.app{display:grid;grid-template-columns:280px 1fr;min-height:100vh}.side{position:relative;background:#0d1726;color:#dbe7ff;padding:26px 20px;overflow:hidden}.side:before{content:"";position:absolute;width:360px;height:360px;border-radius:50%;background:radial-gradient(circle,rgba(16,163,127,.32),transparent 64%);left:-160px;top:-120px}.brand{position:relative;display:flex;gap:12px;align-items:center;margin-bottom:34px}.mark{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center}.mark svg{width:24px;height:24px;fill:#fff}.brand b{display:block;font-size:15px}.brand span{display:block;color:#8fa1bd;font-size:12px;margin-top:3px}.nav{position:relative;display:grid;gap:8px}.nav a{display:flex;align-items:center;gap:11px;text-decoration:none;color:#9fb0cb;padding:12px;border-radius:14px;font-size:14px}.nav a.active{background:rgba(255,255,255,.1);color:#fff}.nav i{width:22px;height:22px;border-radius:8px;background:rgba(255,255,255,.08);display:grid;place-items:center;font-style:normal;font-size:12px}.sidecard{position:absolute;left:20px;right:20px;bottom:22px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.07);border-radius:20px;padding:14px}.sidecard small{color:#8fa1bd}.sidecard code{display:block;margin-top:8px;color:#cfe5ff;font-size:11px;word-break:break-all}.main{padding:28px 34px 36px}.topbar{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:24px}.title h1{margin:0 0 6px;font-size:30px;letter-spacing:-.04em}.title p{margin:0;color:#6a778b;font-size:14px}.actions{display:flex;gap:10px}.btn{height:42px;border:0;border-radius:14px;padding:0 16px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}.btn.primary{background:#101827;color:#fff}.btn.ghost{background:#fff;color:#526176;border:1px solid #e3e9f2}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.metric{background:#fff;border:1px solid #e7edf5;border-radius:22px;padding:17px 18px}.metric span{display:block;color:#7a8799;font-size:12px}.metric b{display:block;font-size:26px;margin-top:7px}.metric em{font-style:normal;color:#10a37f;font-size:12px}.layout{display:grid;grid-template-columns:1fr 430px;gap:20px}.panel{background:#fff;border:1px solid #e5ebf4;border-radius:24px;box-shadow:0 16px 46px rgba(31,45,72,.05);overflow:hidden}.panelHead{padding:18px 20px;border-bottom:1px solid #edf1f6;display:flex;align-items:center;justify-content:space-between}.panelHead h2{margin:0;font-size:16px}.panelHead span{color:#7b8899;font-size:13px}.ws{display:grid;grid-template-columns:42px 1fr auto;gap:13px;align-items:start;padding:16px 20px;border-bottom:1px solid #f0f3f8}.avatar{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center;color:white;font-weight:900}.ws h3{margin:0 0 5px;font-size:15px}.ws p{margin:0;color:#728096;font-size:12px;line-height:1.55}.chips{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}.chip{font-size:11px;padding:4px 7px;border-radius:999px;background:#f1f5f9;color:#536278;border:1px solid #e2e8f0}.state{padding:6px 9px;border-radius:999px;font-size:12px;font-weight:800}.state.on{background:#edfdf7;color:#08745c}.state.off{background:#f3f4f6;color:#6b7280}.edit{margin-top:10px;background:#eef2ff;color:#4f46e5;border-radius:10px;padding:7px 10px;font-weight:800;text-decoration:none;display:inline-block}.form{padding:20px}.form h2{margin:0 0 4px;font-size:20px}.form p{margin:0 0 18px;color:#778499;font-size:13px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:block;margin:12px 0 7px;color:#364356;font-size:12px;font-weight:800}input,textarea{width:100%;border:1px solid #dce4ef;border-radius:14px;background:#fbfdff;color:#111827;padding:11px 12px;font-size:13px;outline:none}textarea{min-height:88px;resize:vertical;font-family:inherit;line-height:1.5}input:focus,textarea:focus{border-color:#10a37f;box-shadow:0 0 0 4px rgba(16,163,127,.11);background:#fff}.switchrow{display:flex;justify-content:space-between;align-items:center;margin:16px 0;padding:13px;border:1px solid #e6edf5;background:#f8fafc;border-radius:16px}.switchrow b{font-size:13px}.switchrow span{display:block;color:#7a8799;font-size:12px;margin-top:2px}.save{width:100%;height:48px;border:0;border-radius:16px;background:#101827;color:#fff;font-weight:900;font-size:14px}.danger{margin:10px 20px 20px;width:calc(100% - 40px);height:42px;border:1px solid #fee2e2;color:#b91c1c;background:#fff7f7;border-radius:14px;font-weight:800}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}@media(max-width:1100px){.app{grid-template-columns:1fr}.side{display:none}.layout{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.main{padding:20px 14px}.topbar{display:block}.actions{margin-top:14px}.metrics{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}.ws{grid-template-columns:42px 1fr}}
</style></head><body><div class="app"><aside class="side"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24"><path d="M12 2.5c5.25 0 9.5 4.03 9.5 9s-4.25 9-9.5 9c-1.56 0-3.04-.36-4.34-1.01L3 20.5l1.18-4.3A8.57 8.57 0 0 1 2.5 11.5c0-4.97 4.25-9 9.5-9Z"/></svg></div><div><b>Invite OIDC</b><span>Admin Console</span></div></div><nav class="nav"><a class="active" href="/admin"><i>🏢</i>Workspaces</a><a href="/.well-known/openid-configuration"><i>🔐</i>OIDC Endpoints</a><a href="/jwks"><i>🔑</i>JWKS</a><a href="/healthz"><i>✓</i>Health</a></nav><div class="sidecard"><small>Discovery URL</small><code>${issuer}/.well-known/openid-configuration</code></div></aside><main class="main">${body}</main></div></body></html>`);
}
async function adminPage(env: Env, editId = ""): Promise<Response> {
  const workspaces = await getWorkspaces(env);
  const edit = editId ? await findWorkspaceById(env, editId) : undefined;
  const ws = edit || { id: "", name: "", client_id: "", client_secret: randomToken(24), invite_code: randomToken(18), allowed_email_domains: [], redirect_uris: [], family_name: "Example", enabled: true } as Workspace;
  const enabledCount = workspaces.filter((w) => w.enabled).length;
  const domainCount = new Set(workspaces.flatMap((w) => w.allowed_email_domains)).size;
  const list = workspaces.map((w) => {
    const chips = w.allowed_email_domains.map((domain) => `<span class="chip">@${esc(domain)}</span>`).join("") + `<span class="chip">family_name: ${esc(w.family_name)}</span>`;
    return `<article class="ws"><div class="avatar">${esc((w.name.slice(0, 1) || "W").toUpperCase())}</div><div><h3>${esc(w.name)}</h3><p>Client ID: <span class="mono">${esc(w.client_id)}</span><br>Redirect: <span class="mono">${esc(w.redirect_uris[0] || "-")}</span></p><div class="chips">${chips}</div></div><div><span class="state ${w.enabled ? "on" : "off"}">${w.enabled ? "Enabled" : "Disabled"}</span><br><a class="edit" href="/admin?edit=${encodeURIComponent(w.id)}">Edit</a></div></article>`;
  }).join("") || `<article class="ws"><div class="avatar">+</div><div><h3>No workspaces yet</h3><p>Create the first ChatGPT/OpenAI SSO workspace.</p></div></article>`;
  const deleteForm = edit ? `<form method="post" action="/admin/delete" onsubmit="return confirm('Delete workspace?')"><input type="hidden" name="id" value="${esc(ws.id)}"><button class="danger">删除当前 Workspace</button></form>` : "";
  const form = `<div class="panel"><form class="form" method="post" action="/admin/save"><h2>${edit ? "编辑 Workspace" : "新增 Workspace"}</h2><p>敏感值请妥善保存；配置会写入服务端持久化存储。</p><input type="hidden" name="original_id" value="${esc(edit?.id || "")}"><div class="grid2"><div><label>ID</label><input name="id" value="${esc(ws.id)}" placeholder="acidtech"></div><div><label>Name</label><input name="name" value="${esc(ws.name)}" placeholder="AcidTech Workspace" required></div></div><label>Client ID</label><input name="client_id" value="${esc(ws.client_id)}" placeholder="chatgpt-sso-acidtech" required><label>Client Secret</label><input name="client_secret" type="password" value="${esc(ws.client_secret)}" required><label>Invite Code</label><input name="invite_code" type="password" value="${esc(ws.invite_code)}" required><label>Allowed Email Domains</label><textarea name="allowed_email_domains" rows="3" required>${esc(ws.allowed_email_domains.join("\n"))}</textarea><label>Redirect / Callback / Fallback URLs</label><textarea name="redirect_uris" rows="5" required>${esc(ws.redirect_uris.join("\n"))}</textarea><div class="grid2"><div><label>Family Name claim</label><input name="family_name" value="${esc(ws.family_name)}"></div><div><label>Issuer</label><input value="${esc(config(env).issuer)}" disabled></div></div><div class="switchrow"><div><b>启用 Workspace</b><span>关闭后不会参与 OIDC 匹配</span></div><input style="width:auto" type="checkbox" name="enabled" ${ws.enabled ? "checked" : ""}></div><button class="save">保存 Workspace</button></form>${deleteForm}</div>`;
  const body = `<div class="topbar"><div class="title"><h1>Workspace 管理</h1><p>为每个 OpenAI / ChatGPT Workspace 独立配置 Client、邀请码、邮箱域名和回调地址。</p></div><div class="actions"><a class="btn ghost" href="/.well-known/openid-configuration">查看 Discovery</a><a class="btn primary" href="/admin">+ 新增 Workspace</a></div></div><section class="metrics"><div class="metric"><span>Workspaces</span><b>${workspaces.length}</b><em>${enabledCount} enabled</em></div><div class="metric"><span>Allowed domains</span><b>${domainCount}</b><em>isolated per workspace</em></div><div class="metric"><span>Signing</span><b>RS256</b><em>active JWKS</em></div><div class="metric"><span>Token TTL</span><b>${config(env).tokenTtl}s</b><em>default</em></div></section><section class="layout"><div class="panel"><div class="panelHead"><h2>Workspace 列表</h2><span>按 client_id + redirect_uri 匹配</span></div><div class="list">${list}</div></div>${form}</section>`;
  return adminShell(body, env);
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
