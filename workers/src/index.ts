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
  return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT SSO</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(92vw,420px);background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px;font-size:26px}p{color:#94a3b8}label{display:block;margin:16px 0 6px;color:#cbd5e1}input{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#fff;font-size:16px}button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:#10a37f;color:white;font-weight:700;font-size:16px;cursor:pointer}.err{background:#7f1d1d;color:#fecaca;padding:10px;border-radius:10px;margin:12px 0}small{color:#64748b}</style></head><body><main class="card"><h1>${esc(ws.name)}</h1><p>输入 ${esc(allowedDomainsText(ws))} 邮箱和邀请码登录。</p>${err}<form method="post" action="/authorize">${hidden}<label>Email</label><input name="email" type="email" placeholder="you@${esc(ws.allowed_email_domains[0] || "example.com")}" required autofocus><label>Invite code</label><input name="invite_code" type="password" required><button type="submit">Continue to ChatGPT</button></form><p><small>Client ID: ${esc(ws.client_id)}</small></p></main></body></html>`);
}
function adminShell(body: string): Response {
  return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OIDC Admin</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;margin:0;padding:28px}.wrap{max-width:1100px;margin:auto}.card{background:#111827;border:1px solid #334155;border-radius:16px;padding:20px;margin:16px 0}a{color:#5eead4}input,textarea{box-sizing:border-box;width:100%;padding:10px;border-radius:8px;border:1px solid #475569;background:#020617;color:#fff}label{display:block;margin-top:12px;color:#cbd5e1}button{padding:10px 14px;border:0;border-radius:8px;background:#10a37f;color:#fff;font-weight:700;cursor:pointer}.danger{background:#991b1b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.muted{color:#94a3b8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}</style></head><body><main class="wrap"><h1>ChatGPT Invite OIDC Admin</h1>${body}</main></body></html>`);
}
async function adminPage(env: Env, editId = ""): Promise<Response> {
  const workspaces = await getWorkspaces(env);
  const edit = editId ? await findWorkspaceById(env, editId) : undefined;
  const ws = edit || { id: "", name: "", client_id: "", client_secret: randomToken(24), invite_code: randomToken(18), allowed_email_domains: [], redirect_uris: [], family_name: "Example", enabled: true } as Workspace;
  const list = workspaces.map((w) => `<div class="card"><h2>${esc(w.name)}</h2><p class="muted">${w.enabled ? "Enabled" : "Disabled"} · <span class="mono">${esc(w.id)}</span></p><p>Client ID: <span class="mono">${esc(w.client_id)}</span></p><p>Client Secret: <span class="mono">${esc(maskSecret(w.client_secret))}</span></p><p>Domains: ${esc(allowedDomainsText(w))}</p><p>Redirect/Fallback URLs:<br>${w.redirect_uris.map((u) => `<span class="mono">${esc(u)}</span>`).join("<br>")}</p><p><a href="/admin?edit=${encodeURIComponent(w.id)}">Edit</a></p><form method="post" action="/admin/delete" onsubmit="return confirm('Delete workspace?')"><input type="hidden" name="id" value="${esc(w.id)}"><button class="danger">Delete</button></form></div>`).join("") || `<p class="muted">No workspaces yet.</p>`;
  const form = `<div class="card"><h2>${edit ? "Edit" : "Add"} Workspace</h2><form method="post" action="/admin/save"><input type="hidden" name="original_id" value="${esc(edit?.id || "")}"><label>ID</label><input name="id" value="${esc(ws.id)}" placeholder="acidtech"><label>Name</label><input name="name" value="${esc(ws.name)}" placeholder="AcidTech Workspace" required><label>Client ID</label><input name="client_id" value="${esc(ws.client_id)}" placeholder="chatgpt-sso-acidtech" required><label>Client Secret</label><input name="client_secret" value="${esc(ws.client_secret)}" required><p class="muted">Keep this secret. Use the value in OpenAI SSO settings.</p><label>Invite Code</label><input name="invite_code" value="${esc(ws.invite_code)}" required><label>Allowed Email Domains, one per line or comma-separated</label><textarea name="allowed_email_domains" rows="3" required>${esc(ws.allowed_email_domains.join("\n"))}</textarea><label>Redirect / Callback / Fallback URLs, one per line or comma-separated</label><textarea name="redirect_uris" rows="5" required>${esc(ws.redirect_uris.join("\n"))}</textarea><label>Family Name claim</label><input name="family_name" value="${esc(ws.family_name)}"><label><input style="width:auto" type="checkbox" name="enabled" ${ws.enabled ? "checked" : ""}> Enabled</label><button>Save Workspace</button> <a href="/admin">New</a></form></div>`;
  return adminShell(`<p>Discovery URL: <span class="mono">${esc(config(env).issuer)}/.well-known/openid-configuration</span></p><div class="grid">${list}</div>${form}`);
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
