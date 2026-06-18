from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, Form, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


def parse_list(value: str | None) -> list[str]:
    if not value:
        return []
    parts = []
    for chunk in value.replace("\n", ",").split(","):
        chunk = chunk.strip()
        if chunk and chunk not in parts:
            parts.append(chunk)
    return parts


def parse_domains(value: str | None) -> list[str]:
    out = []
    for domain in parse_list(value):
        domain = domain.lower().lstrip("@")
        if domain and domain not in out:
            out.append(domain)
    return out


@dataclass
class Workspace:
    id: str
    name: str
    client_id: str
    client_secret: str
    invite_code: str
    allowed_email_domains: list[str]
    redirect_uris: list[str]
    family_name: str = "Example"
    enabled: bool = True


@dataclass
class Settings:
    issuer: str = os.getenv("OIDC_ISSUER", "https://oidc.example.com").rstrip("/")
    client_id: str = os.getenv("OIDC_CLIENT_ID", "chatgpt-sso")
    client_secret: str = os.getenv("OIDC_CLIENT_SECRET", "")
    invite_code: str = os.getenv("INVITE_CODE", "")
    allowed_email_domains: list[str] = None  # type: ignore[assignment]
    allowed_redirect_uris: list[str] = None  # type: ignore[assignment]
    admin_password: str = os.getenv("ADMIN_PASSWORD", "")
    code_ttl_seconds: int = int(os.getenv("CODE_TTL_SECONDS", "300"))
    token_ttl_seconds: int = int(os.getenv("TOKEN_TTL_SECONDS", "3600"))
    rate_limit_window_seconds: int = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
    rate_limit_max_attempts: int = int(os.getenv("RATE_LIMIT_MAX_ATTEMPTS", "10"))
    data_dir: Path = Path(os.getenv("DATA_DIR", "/data"))

    def __post_init__(self):
        domains = os.getenv("ALLOWED_EMAIL_DOMAINS") or os.getenv("ALLOWED_EMAIL_DOMAIN", "example.com")
        self.allowed_email_domains = parse_domains(domains)
        redirects = os.getenv("ALLOWED_REDIRECT_URIS", "")
        self.allowed_redirect_uris = parse_list(redirects)


settings = Settings()
app = FastAPI(title="ChatGPT Invite OIDC", version="0.2.0")
security = HTTPBearer(auto_error=False)

codes: dict[str, dict] = {}
access_tokens: dict[str, dict] = {}
rate_buckets: dict[str, list[float]] = {}


def slug(value: str) -> str:
    import re

    out = re.sub(r"[^a-z0-9_-]+", "-", value.lower().strip()).strip("-")
    return out or f"ws-{int(time.time())}"


def safe_equal(a: str, b: str) -> bool:
    return secrets.compare_digest(a or "", b or "")


def legacy_workspace() -> Workspace | None:
    if not (settings.client_id and settings.client_secret and settings.invite_code and settings.allowed_redirect_uris):
        return None
    return Workspace(
        id="default",
        name="Default Workspace",
        client_id=settings.client_id,
        client_secret=settings.client_secret,
        invite_code=settings.invite_code,
        allowed_email_domains=settings.allowed_email_domains or ["example.com"],
        redirect_uris=settings.allowed_redirect_uris,
        family_name=os.getenv("FAMILY_NAME", "Example"),
        enabled=True,
    )


def workspaces_path() -> Path:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return settings.data_dir / "workspaces.json"


def load_stored_workspaces() -> list[Workspace]:
    path = workspaces_path()
    if not path.exists():
        return []
    raw = json.loads(path.read_text())
    return [Workspace(**item) for item in raw]


def save_stored_workspaces(workspaces: list[Workspace]):
    path = workspaces_path()
    path.write_text(json.dumps([asdict(ws) for ws in workspaces], ensure_ascii=False, indent=2))
    try:
        path.chmod(0o600)
    except OSError:
        pass


def get_workspaces() -> list[Workspace]:
    workspaces = load_stored_workspaces()
    legacy = legacy_workspace()
    if legacy and not any(ws.id == legacy.id or ws.client_id == legacy.client_id for ws in workspaces):
        workspaces.append(legacy)
    return workspaces


def find_workspace_by_client(client_id: str) -> Workspace | None:
    return next((ws for ws in get_workspaces() if ws.enabled and ws.client_id == client_id), None)


def find_workspace_by_id(workspace_id: str) -> Workspace | None:
    return next((ws for ws in get_workspaces() if ws.id == workspace_id), None)


def save_workspace(ws: Workspace):
    workspaces = [item for item in load_stored_workspaces() if item.id != ws.id]
    workspaces.append(ws)
    save_stored_workspaces(workspaces)


def delete_workspace(workspace_id: str):
    save_stored_workspaces([ws for ws in load_stored_workspaces() if ws.id != workspace_id])


def _b64url_uint(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _load_or_create_private_key():
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    key_path = settings.data_dir / "oidc_private_key.pem"
    if key_path.exists():
        return serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    try:
        key_path.chmod(0o600)
    except OSError:
        pass
    return key


private_key = _load_or_create_private_key()
public_numbers = private_key.public_key().public_numbers()
kid = hashlib.sha256(
    private_key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
).hexdigest()[:16]


def jwk() -> dict:
    return {"kty": "RSA", "use": "sig", "kid": kid, "alg": "RS256", "n": _b64url_uint(public_numbers.n), "e": _b64url_uint(public_numbers.e)}


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate_limit(request: Request):
    ip = client_ip(request)
    now = time.time()
    window_start = now - settings.rate_limit_window_seconds
    attempts = [t for t in rate_buckets.get(ip, []) if t >= window_start]
    if len(attempts) >= settings.rate_limit_max_attempts:
        raise HTTPException(status_code=429, detail="Too many attempts")
    attempts.append(now)
    rate_buckets[ip] = attempts


def validate_client(client_id: str, redirect_uri: str) -> Workspace:
    ws = find_workspace_by_client(client_id)
    if not ws:
        raise HTTPException(status_code=400, detail="invalid client_id")
    if redirect_uri not in ws.redirect_uris:
        raise HTTPException(status_code=400, detail="invalid redirect_uri")
    return ws


def allowed_domains_text(ws: Workspace) -> str:
    return ", ".join(f"@{domain}" for domain in ws.allowed_email_domains)


def email_domain_allowed(ws: Workspace, email: str) -> bool:
    return any(email.endswith("@" + domain) for domain in ws.allowed_email_domains)


def make_claims(ws: Workspace, email: str) -> dict:
    local = email.split("@", 1)[0]
    return {"sub": email, "email": email, "email_verified": True, "given_name": local, "family_name": ws.family_name, "name": local, "preferred_username": local}


def html_login(ws: Workspace, params: dict, error: str | None = None) -> HTMLResponse:
    hidden = "".join(f'<input type="hidden" name="{k}" value="{str(v).replace("&", "&amp;").replace(chr(34), "&quot;")}">' for k, v in params.items())
    error_html = f'<div class="err">{error}</div>' if error else ""
    placeholder_domain = ws.allowed_email_domains[0] if ws.allowed_email_domains else "example.com"
    return HTMLResponse(
        f"""
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT SSO</title><style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}}.card{{width:min(92vw,420px);background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}}h1{{margin:0 0 8px;font-size:26px}}p{{color:#94a3b8}}label{{display:block;margin:16px 0 6px;color:#cbd5e1}}input{{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#fff;font-size:16px}}button{{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:#10a37f;color:white;font-weight:700;font-size:16px;cursor:pointer}}.err{{background:#7f1d1d;color:#fecaca;padding:10px;border-radius:10px;margin:12px 0}}small{{color:#64748b}}</style></head><body><main class="card"><h1>{ws.name}</h1><p>输入 {allowed_domains_text(ws)} 邮箱和邀请码登录。</p>{error_html}<form method="post" action="/authorize">{hidden}<label>Email</label><input name="email" type="email" placeholder="you@{placeholder_domain}" required autofocus><label>Invite code</label><input name="invite_code" type="password" required><button type="submit">Continue to ChatGPT</button></form><p><small>Client ID: {ws.client_id}</small></p></main></body></html>
"""
    )


def basic_client_secret(authorization: str | None):
    if not authorization or not authorization.lower().startswith("basic "):
        return None, None
    raw = base64.b64decode(authorization.split(" ", 1)[1]).decode()
    client_id, client_secret = raw.split(":", 1)
    return client_id, client_secret


def require_admin(request: Request):
    if not settings.admin_password:
        raise HTTPException(status_code=503, detail="ADMIN_PASSWORD is not configured")
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("basic "):
        raise HTTPException(status_code=401, detail="admin authentication required", headers={"WWW-Authenticate": 'Basic realm="ChatGPT OIDC Admin"'})
    raw = base64.b64decode(auth.split(" ", 1)[1]).decode()
    _, password = raw.split(":", 1)
    if not safe_equal(password, settings.admin_password):
        raise HTTPException(status_code=401, detail="admin authentication required", headers={"WWW-Authenticate": 'Basic realm="ChatGPT OIDC Admin"'})


def admin_shell(body: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OIDC Admin</title><style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;margin:0;padding:28px}}.wrap{{max-width:1100px;margin:auto}}.card{{background:#111827;border:1px solid #334155;border-radius:16px;padding:20px;margin:16px 0}}a{{color:#5eead4}}input,textarea{{box-sizing:border-box;width:100%;padding:10px;border-radius:8px;border:1px solid #475569;background:#020617;color:#fff}}label{{display:block;margin-top:12px;color:#cbd5e1}}button{{padding:10px 14px;border:0;border-radius:8px;background:#10a37f;color:#fff;font-weight:700;cursor:pointer}}.danger{{background:#991b1b}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}}.muted{{color:#94a3b8}}.mono{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}}</style></head><body><main class="wrap"><h1>ChatGPT Invite OIDC Admin</h1>{body}</main></body></html>""")


@app.get("/admin")
def admin_page(request: Request, edit: str = ""):
    require_admin(request)
    workspaces = get_workspaces()
    selected = find_workspace_by_id(edit) if edit else None
    ws = selected or Workspace("", "", "", secrets.token_urlsafe(24), secrets.token_urlsafe(18), [], [], "Example", True)
    cards = "".join(f'<div class="card"><h2>{item.name}</h2><p class="muted">{("Enabled" if item.enabled else "Disabled")} · <span class="mono">{item.id}</span></p><p>Client ID: <span class="mono">{item.client_id}</span></p><p>Domains: {allowed_domains_text(item)}</p><p>{"<br>".join(item.redirect_uris)}</p><p><a href="/admin?edit={item.id}">Edit</a></p><form method="post" action="/admin/delete"><input type="hidden" name="id" value="{item.id}"><button class="danger">Delete</button></form></div>' for item in workspaces)
    form = f'<div class="card"><h2>{"Edit" if selected else "Add"} Workspace</h2><form method="post" action="/admin/save"><input type="hidden" name="original_id" value="{selected.id if selected else ""}"><label>ID</label><input name="id" value="{ws.id}"><label>Name</label><input name="name" value="{ws.name}" required><label>Client ID</label><input name="client_id" value="{ws.client_id}" required><label>Client Secret</label><input name="client_secret" value="{ws.client_secret}" required><label>Invite Code</label><input name="invite_code" value="{ws.invite_code}" required><label>Allowed Email Domains</label><textarea name="allowed_email_domains" rows="3" required>{chr(10).join(ws.allowed_email_domains)}</textarea><label>Redirect / Callback / Fallback URLs</label><textarea name="redirect_uris" rows="5" required>{chr(10).join(ws.redirect_uris)}</textarea><label>Family Name claim</label><input name="family_name" value="{ws.family_name}"><label><input style="width:auto" type="checkbox" name="enabled" {"checked" if ws.enabled else ""}> Enabled</label><button>Save Workspace</button></form></div>'
    return admin_shell(f'<p>Discovery URL: <span class="mono">{settings.issuer}/.well-known/openid-configuration</span></p><div class="grid">{cards}</div>{form}')


@app.post("/admin/save")
def admin_save(
    request: Request,
    original_id: Annotated[str, Form()] = "",
    id: Annotated[str, Form()] = "",
    name: Annotated[str, Form()] = "",
    client_id: Annotated[str, Form()] = "",
    client_secret: Annotated[str, Form()] = "",
    invite_code: Annotated[str, Form()] = "",
    allowed_email_domains: Annotated[str, Form()] = "",
    redirect_uris: Annotated[str, Form()] = "",
    family_name: Annotated[str, Form()] = "Example",
    enabled: Annotated[str | None, Form()] = None,
):
    require_admin(request)
    workspace_id = slug(id or name or client_id)
    if original_id and original_id != workspace_id:
        delete_workspace(original_id)
    save_workspace(Workspace(workspace_id, name, client_id, client_secret, invite_code, parse_domains(allowed_email_domains), parse_list(redirect_uris), family_name or "Example", enabled == "on"))
    return RedirectResponse("/admin", status_code=302)


@app.post("/admin/delete")
def admin_delete(request: Request, id: Annotated[str, Form()]):
    require_admin(request)
    delete_workspace(id)
    return RedirectResponse("/admin", status_code=302)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/.well-known/openid-configuration")
def discovery():
    return {"issuer": settings.issuer, "authorization_endpoint": f"{settings.issuer}/authorize", "token_endpoint": f"{settings.issuer}/token", "userinfo_endpoint": f"{settings.issuer}/userinfo", "jwks_uri": f"{settings.issuer}/jwks", "response_types_supported": ["code"], "subject_types_supported": ["public"], "id_token_signing_alg_values_supported": ["RS256"], "scopes_supported": ["openid", "email", "profile"], "claims_supported": ["sub", "email", "email_verified", "given_name", "family_name", "name", "preferred_username"], "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]}


@app.get("/jwks")
def jwks():
    return {"keys": [jwk()]}


@app.get("/authorize", response_class=HTMLResponse)
def authorize_form(client_id: str, redirect_uri: str, response_type: str, scope: str = "openid email profile", state: str | None = None, nonce: str | None = None):
    ws = validate_client(client_id, redirect_uri)
    if response_type != "code":
        raise HTTPException(status_code=400, detail="unsupported response_type")
    return html_login(ws, locals())


@app.post("/authorize")
def authorize_submit(request: Request, client_id: Annotated[str, Form()], redirect_uri: Annotated[str, Form()], response_type: Annotated[str, Form()], scope: Annotated[str, Form()] = "openid email profile", state: Annotated[str | None, Form()] = None, nonce: Annotated[str | None, Form()] = None, email: Annotated[str, Form()] = "", invite_code: Annotated[str, Form()] = ""):
    check_rate_limit(request)
    ws = validate_client(client_id, redirect_uri)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": response_type, "scope": scope, "state": state or "", "nonce": nonce or ""}
    email = email.strip().lower()
    if not email_domain_allowed(ws, email):
        response = html_login(ws, params, f"邮箱必须是以下域名之一 / Email must use one of: {allowed_domains_text(ws)}")
        response.status_code = 400
        return response
    if invite_code != ws.invite_code:
        response = html_login(ws, params, "邀请码不正确 / Invalid invite code")
        response.status_code = 401
        return response
    if response_type != "code":
        raise HTTPException(status_code=400, detail="unsupported response_type")
    code = secrets.token_urlsafe(32)
    codes[code] = {"email": email, "redirect_uri": redirect_uri, "client_id": client_id, "workspace_id": ws.id, "scope": scope, "nonce": nonce, "expires_at": time.time() + settings.code_ttl_seconds}
    query = {"code": code}
    if state:
        query["state"] = state
    return RedirectResponse(redirect_uri + "?" + urlencode(query), status_code=302)


@app.post("/token")
def token(grant_type: Annotated[str, Form()], code: Annotated[str, Form()], redirect_uri: Annotated[str, Form()], client_id: Annotated[str | None, Form()] = None, client_secret: Annotated[str | None, Form()] = None, authorization: Annotated[str | None, Header()] = None):
    basic_id, basic_secret = basic_client_secret(authorization)
    client_id = client_id or basic_id
    client_secret = client_secret or basic_secret
    ws = find_workspace_by_client(client_id or "")
    if not ws or not safe_equal(client_secret or "", ws.client_secret):
        raise HTTPException(status_code=401, detail="invalid_client")
    if grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="unsupported_grant_type")
    item = codes.get(code)
    if not item or item["expires_at"] < time.time():
        raise HTTPException(status_code=400, detail="invalid_grant")
    if item["redirect_uri"] != redirect_uri or item["client_id"] != client_id or item.get("workspace_id") != ws.id:
        raise HTTPException(status_code=400, detail="invalid_grant")
    codes.pop(code, None)
    now = int(time.time())
    claims = make_claims(ws, item["email"])
    id_payload = {**claims, "iss": settings.issuer, "aud": ws.client_id, "iat": now, "exp": now + settings.token_ttl_seconds}
    if item.get("nonce"):
        id_payload["nonce"] = item["nonce"]
    id_token = jwt.encode(id_payload, private_key, algorithm="RS256", headers={"kid": kid})
    access_token = secrets.token_urlsafe(32)
    access_tokens[access_token] = {"claims": claims, "expires_at": now + settings.token_ttl_seconds}
    return {"access_token": access_token, "id_token": id_token, "token_type": "Bearer", "expires_in": settings.token_ttl_seconds, "scope": item.get("scope", "openid email profile")}


@app.get("/userinfo")
def userinfo(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if not credentials:
        raise HTTPException(status_code=401, detail="missing bearer token")
    item = access_tokens.get(credentials.credentials)
    if not item or item["expires_at"] < time.time():
        raise HTTPException(status_code=401, detail="invalid token")
    return item["claims"]
