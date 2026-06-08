export interface Env {
  OIDC_KV: KVNamespace;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_PRIVATE_JWK?: string;
  INVITE_CODE: string;
  ALLOWED_REDIRECT_URIS: string;
  ALLOWED_EMAIL_DOMAIN: string;
  FAMILY_NAME?: string;
  TOKEN_TTL_SECONDS?: string;
  CODE_TTL_SECONDS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_MAX_ATTEMPTS?: string;
  ADMIN_EMAILS?: string;
  ADMIN_INVITE_CODE?: string;
}

type AuthCode = { email: string; redirect_uri: string; client_id: string; scope: string; nonce?: string };
type Claims = { sub: string; email: string; email_verified: true; given_name: string; family_name: string; name: string; preferred_username: string };

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`Missing required configuration: ${name}`);
  return v;
}
function toInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function config(env: Env) {
  return {
    issuer: required(env.OIDC_ISSUER, "OIDC_ISSUER").replace(/\/$/, ""),
    clientId: required(env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID"),
    clientSecret: required(env.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET"),
    privateJwk: env.OIDC_PRIVATE_JWK || "",
    inviteCode: required(env.INVITE_CODE, "INVITE_CODE"),
    redirects: required(env.ALLOWED_REDIRECT_URIS, "ALLOWED_REDIRECT_URIS").split(",").map((x) => x.trim()).filter(Boolean),
    domain: required(env.ALLOWED_EMAIL_DOMAIN, "ALLOWED_EMAIL_DOMAIN").toLowerCase().replace(/^@/, ""),
    familyName: env.FAMILY_NAME || "Example",
    tokenTtl: toInt(env.TOKEN_TTL_SECONDS, 3600),
    codeTtl: toInt(env.CODE_TTL_SECONDS, 300),
    rateWindow: toInt(env.RATE_LIMIT_WINDOW_SECONDS, 60),
    rateMax: toInt(env.RATE_LIMIT_MAX_ATTEMPTS, 10),
    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    adminInviteCode: env.ADMIN_INVITE_CODE || "",
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
function validateClient(env: Env, clientId: string, redirectUri: string): Response | undefined {
  const c = config(env);
  if (clientId !== c.clientId) return json({ error: "invalid_client_id" }, 400);
  if (!c.redirects.includes(redirectUri)) return json({ error: "invalid_redirect_uri" }, 400);
  return undefined;
}

function validateInviteForEmail(env: Env, email: string, inviteCode: string): string | undefined {
  const c = config(env);
  const isAdminEmail = c.adminEmails.includes(email);
  if (isAdminEmail) {
    if (!c.adminInviteCode) return "管理账号未配置独立邀请码 / Admin invite code is not configured";
    if (!safeEqual(inviteCode, c.adminInviteCode)) return "管理账号邀请码不正确 / Invalid admin invite code";
    return undefined;
  }
  if (!safeEqual(inviteCode, c.inviteCode)) return "邀请码不正确 / Invalid invite code";
  return undefined;
}

function claims(env: Env, email: string): Claims {
  const local = email.split("@", 1)[0];
  return { sub: email, email, email_verified: true, given_name: local, family_name: config(env).familyName, name: local, preferred_username: local };
}
function loginPage(env: Env, params: Record<string, string>, error = ""): Response {
  const c = config(env);
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const err = error ? `<div class="err">${esc(error)}</div>` : "";
  return html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT SSO</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(92vw,420px);background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px;font-size:26px}p{color:#94a3b8}label{display:block;margin:16px 0 6px;color:#cbd5e1}input{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#fff;font-size:16px}button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:#10a37f;color:white;font-weight:700;font-size:16px;cursor:pointer}.err{background:#7f1d1d;color:#fecaca;padding:10px;border-radius:10px;margin:12px 0}small{color:#64748b}</style></head><body><main class="card"><h1>ChatGPT SSO</h1><p>输入 @${esc(c.domain)} 邮箱和邀请码登录。</p>${err}<form method="post" action="/authorize">${hidden}<label>Email</label><input name="email" type="email" placeholder="you@${esc(c.domain)}" required autofocus><label>Invite code</label><input name="invite_code" type="password" required><button type="submit">Continue to ChatGPT</button></form><p><small>No account registration required.</small></p></main></body></html>`);
}
type JwkWithKid = JsonWebKey & { kid?: string };

async function generatePrivateJwk(): Promise<JwkWithKid> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JwkWithKid;
  jwk.kid = jwk.kid || "main";
  jwk.alg = "RS256";
  jwk.key_ops = ["sign"];
  jwk.ext = true;
  return jwk;
}

async function getPrivateJwk(env: Env): Promise<JwkWithKid> {
  const configured = config(env).privateJwk;
  if (configured) return JSON.parse(configured) as JwkWithKid;
  const key = "config:oidc_private_jwk";
  const existing = await env.OIDC_KV.get(key);
  if (existing) return JSON.parse(existing) as JwkWithKid;
  const jwk = await generatePrivateJwk();
  // Persist the generated signing key so /jwks and issued tokens remain stable across deploys.
  await env.OIDC_KV.put(key, JSON.stringify(jwk));
  return jwk;
}

async function publicJwk(env: Env): Promise<JwkWithKid> {
  const jwk = { ...(await getPrivateJwk(env)) } as JwkWithKid;
  delete jwk.d; delete jwk.p; delete jwk.q; delete jwk.dp; delete jwk.dq; delete jwk.qi;
  // Keep JWKS public keys minimal for strict OIDC validators.
  delete jwk.key_ops;
  delete jwk.ext;
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
function basicAuth(request: Request): { id: string; secret: string } | undefined {
  const h = request.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("basic ")) return undefined;
  const raw = atob(h.slice(6));
  const i = raw.indexOf(":");
  return i >= 0 ? { id: raw.slice(0, i), secret: raw.slice(i + 1) } : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true });
      if (url.pathname === "/.well-known/openid-configuration") {
        const c = config(env);
        return json({ issuer: c.issuer, authorization_endpoint: `${c.issuer}/authorize`, token_endpoint: `${c.issuer}/token`, userinfo_endpoint: `${c.issuer}/userinfo`, jwks_uri: `${c.issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid", "email", "profile"], claims_supported: ["sub", "email", "email_verified", "given_name", "family_name", "name", "preferred_username"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] });
      }
      if (url.pathname === "/jwks") return json({ keys: [await publicJwk(env)] });
      if (url.pathname === "/authorize" && request.method === "GET") {
        const params: Record<string, string> = {};
        url.searchParams.forEach((value, key) => { params[key] = value; });
        const invalid = validateClient(env, params.client_id || "", params.redirect_uri || "");
        if (invalid) return invalid;
        if (params.response_type !== "code") return json({ error: "unsupported_response_type" }, 400);
        return loginPage(env, params as Record<string, string>);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const limited = await checkRateLimit(request, env);
        if (limited) return limited;
        const form = await request.formData();
        const params: Record<string, string> = {};
        form.forEach((value, key) => { params[key] = String(value); });
        const invalid = validateClient(env, params.client_id || "", params.redirect_uri || "");
        if (invalid) return invalid;
        const c = config(env);
        const keep = { client_id: params.client_id || "", redirect_uri: params.redirect_uri || "", response_type: params.response_type || "", scope: params.scope || "", state: params.state || "", nonce: params.nonce || "" };
        const email = (params.email || "").trim().toLowerCase();
        if (!email.endsWith(`@${c.domain}`)) return loginPage(env, keep, `邮箱必须是 @${c.domain}`);
        const inviteError = validateInviteForEmail(env, email, params.invite_code || "");
        if (inviteError) return loginPage(env, keep, inviteError);
        if (params.response_type !== "code") return json({ error: "unsupported_response_type" }, 400);
        const code = randomToken();
        const data: AuthCode = { email, redirect_uri: params.redirect_uri, client_id: params.client_id, scope: params.scope || "openid email profile", nonce: params.nonce || undefined };
        await env.OIDC_KV.put(`code:${code}`, JSON.stringify(data), { expirationTtl: c.codeTtl });
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
        const c = config(env);
        if (clientId !== c.clientId || !safeEqual(clientSecret, c.clientSecret)) return json({ error: "invalid_client" }, 401);
        if (String(form.get("grant_type") || "") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
        const code = String(form.get("code") || "");
        const raw = await env.OIDC_KV.get(`code:${code}`);
        if (!raw) return json({ error: "invalid_code" }, 400);
        await env.OIDC_KV.delete(`code:${code}`);
        const data = JSON.parse(raw) as AuthCode;
        if (data.client_id !== clientId || data.redirect_uri !== String(form.get("redirect_uri") || "")) return json({ error: "invalid_grant" }, 400);
        const now = Math.floor(Date.now() / 1000);
        const userClaims = claims(env, data.email);
        const idPayload: Record<string, unknown> = { iss: c.issuer, aud: c.clientId, iat: now, exp: now + c.tokenTtl, ...userClaims };
        if (data.nonce) idPayload.nonce = data.nonce;
        const accessToken = randomToken();
        await env.OIDC_KV.put(`access:${accessToken}`, JSON.stringify(userClaims), { expirationTtl: c.tokenTtl });
        return json({ access_token: accessToken, token_type: "Bearer", expires_in: c.tokenTtl, id_token: await signJwt(env, idPayload) });
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
