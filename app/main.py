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
    domain_chips = "".join(f'<span>@{domain}</span>' for domain in ws.allowed_email_domains)
    domains_text = " / ".join(f"@{domain}" for domain in ws.allowed_email_domains) or "allowed domain"
    initial = (ws.name[:1] or "W").upper()
    return HTMLResponse(
        f"""
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT SSO</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:#111827;background:#f6f7fb;display:grid;place-items:center;overflow:hidden}}.bg{{position:fixed;inset:0;background:radial-gradient(circle at 50% -12%,rgba(16,163,127,.20),transparent 34%),radial-gradient(circle at 86% 22%,rgba(99,102,241,.12),transparent 30%),linear-gradient(180deg,#fff 0%,#f4f7fb 100%)}}.grain{{position:fixed;inset:0;background-image:linear-gradient(rgba(15,23,42,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.55),transparent 75%)}}.card{{position:relative;width:min(92vw,430px);background:rgba(255,255,255,.86);backdrop-filter:blur(24px);border:1px solid rgba(221,228,239,.95);border-radius:30px;padding:30px;box-shadow:0 30px 90px rgba(24,39,68,.14),inset 0 1px 0 rgba(255,255,255,.95)}}.top{{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}}.brand{{display:flex;align-items:center;gap:12px}}.mark{{width:44px;height:44px;border-radius:16px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center;box-shadow:0 14px 34px rgba(16,163,127,.22)}}.mark svg{{width:24px;height:24px;fill:#fff}}.brand b{{display:block;font-size:15px;letter-spacing:-.01em}}.brand span{{display:block;color:#7a8799;font-size:12px;margin-top:2px}}.tag{{font-size:12px;font-weight:800;color:#08745c;background:#edfdf7;border:1px solid #d6f6e9;border-radius:999px;padding:7px 10px}}h1{{margin:0 0 8px;font-size:30px;letter-spacing:-.05em;color:#0f172a}}.sub{{margin:0 0 24px;color:#66758a;font-size:14px}}.wsbox{{display:flex;align-items:center;gap:12px;background:#f8fafc;border:1px solid #e7edf5;border-radius:18px;padding:13px;margin-bottom:22px}}.avatar{{width:38px;height:38px;border-radius:14px;background:#111827;color:#fff;display:grid;p... [truncated]
</style></head><body><div class="bg"></div><div class="grain"></div><main class="card"><div class="top"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24"><path d="M12 2.5c5.25 0 9.5 4.03 9.5 9s-4.25 9-9.5 9c-1.56 0-3.04-.36-4.34-1.01L3 20.5l1.18-4.3A8.57 8.57 0 0 1 2.5 11.5c0-4.97 4.25-9 9.5-9Z"/></svg></div><div><b>Invite OIDC</b><span>ChatGPT SSO</span></div></div><span class="tag">OIDC</span></div><h1>登录</h1><p class="sub">输入邮箱和邀请码继续。</p><div class="wsbox"><div class="avatar">{initial}</div><div><b>{ws.name}</b><span>{domains_text}</span></div></div>{error_html}<form method="post" action="/authorize">{hidden}<div class="field"><label>Email</label><input name="email" type="email" placeholder="you@{placeholder_domain}" required autofocus><div class="domains">{domain_chips}</div></div><div class="field"><label>Invite code</label><input name="invite_code" type="password" placeholder="输入邀请码" required></div><button type="submit">Continue →</button></form><div class="footer"><span><i class="ok"></i>Secure OIDC sign-in</span></div></main></body></html>
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
    return HTMLResponse(f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OIDC Admin</title><style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans SC",sans-serif;color:#172033;background:#f5f7fb}}.app{{display:grid;grid-template-columns:280px 1fr;min-height:100vh}}.side{{position:relative;background:#0d1726;color:#dbe7ff;padding:26px 20px;overflow:hidden}}.side:before{{content:"";position:absolute;width:360px;height:360px;border-radius:50%;background:radial-gradient(circle,rgba(16,163,127,.32),transparent 64%);left:-160px;top:-120px}}.brand{{position:relative;display:flex;gap:12px;align-items:center;margin-bottom:34px}}.mark{{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center;box-shadow:0 16px 40px rgba(16,163,127,.25)}}.mark svg{{width:24px;height:24px;fill:#fff}}.brand b{{display:block;font-size:15px}}.brand span{{display:block;color:#8fa1bd;font-size:12px;margin-top:3px}}.nav{{position:relative;display:grid;gap:8px}}.nav a{{display:flex;align-items:center;gap:11px;text-decoration:none;color:#9fb0cb;padding:12px;border-radius:14px;font-size:14px}}.nav a.active{{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}}.nav i{{width:22px;height:22px;border-radius:8px;background:rgba(255,255,255,.08);display:grid;place-items:center;font-style:normal;font-size:12px}}.sidecard{{position:absolute;left:20px;right:20px;bottom:22px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.07);border-radius:20px;padding:14px}}.sidecard small{{color:#8fa1bd}}.sidecard code{{display:block;margin-top:8px;color:#cfe5ff;font-size:11px;word-break:break-all}}.main{{padding:28px 34px 36px}}.topbar{{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:24px}}.title h1{{margin:0 0 6px;font-size:30px;letter-spacing:-.04em}}.title p{{margin:0;color:#6a778b;font-size:14px}}.actions{{display:flex;gap:10px}}.btn{{height:42px;border:0;border-radius:14px;padding:0 16px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}}.btn.primary{{background:#101827;color:#fff;box-shadow:0 14px 34px rgba(16,24,39,.15)}}.btn.ghost{{background:#fff;color:#526176;border:1px solid #e3e9f2}}.metrics{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}}.metric{{background:#fff;border:1px solid #e7edf5;border-radius:22px;padding:17px 18px;box-shadow:0 12px 34px rgba(31,45,72,.04)}}.metric span{{display:block;color:#7a8799;font-size:12px}}.metric b{{display:block;font-size:26px;margin-top:7px;letter-spacing:-.03em}}.metric em{{font-style:normal;color:#10a37f;font-size:12px}}.layout{{display:grid;grid-template-columns:1fr 430px;gap:20px}}.panel{{background:#fff;border:1px solid #e5ebf4;border-radius:24px;box-shadow:0 16px 46px rgba(31,45,72,.05);overflow:hidden}}.panelHead{{padding:18px 20px;border-bottom:1px solid #edf1f6;display:flex;align-items:center;justify-content:space-between}}.panelHead h2{{margin:0;font-size:16px}}.panelHead span{{color:#7b8899;font-size:13px}}.list{{display:grid}}.ws{{display:grid;grid-template-columns:42px 1fr auto;gap:13px;align-items:start;padding:16px 20px;border-bottom:1px solid #f0f3f8}}.ws:last-child{{border-bottom:0}}.avatar{{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,#10a37f,#6366f1);display:grid;place-items:center;color:white;font-weight:900}}.ws h3{{margin:0 0 5px;font-size:15px}}.ws p{{margin:0;color:#728096;font-size:12px;line-height:1.55}}.chips{{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}}.chip{{font-size:11px;padding:4px 7px;border-radius:999px;background:#f1f5f9;color:#536278;border:1px solid #e2e8f0}}.state{{padding:6px 9px;border-radius:999px;font-size:12px;font-weight:800}}.state.on{{background:#edfdf7;color:#08745c}}.state.off{{background:#f3f4f6;color:#6b7280}}.edit{{margin-top:10px;border:0;background:#eef2ff;color:#4f46e5;border-radius:10px;padding:7px 10px;font-weight:800;text-decoration:none;display:inline-block}}.form{{padding:20px}}.form h2{{margin:0 0 4px;font-size:20px;letter-spacing:-.03em}}.form p{{margin:0 0 18px;color:#778499;font-size:13px}}.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}label{{display:block;margin:12px 0 7px;color:#364356;font-size:12px;font-weight:800}}input,textarea{{width:100%;border:1px solid #dce4ef;border-radius:14px;background:#fbfdff;color:#111827;padding:11px 12px;font-size:13px;outline:none}}textarea{{min-height:88px;resize:vertical;font-family:inherit;line-height:1.5}}input:focus,textarea:focus{{border-color:#10a37f;box-shadow:0 0 0 4px rgba(16,163,127,.11);background:#fff}}.switchrow{{display:flex;justify-content:space-between;align-items:center;margin:16px 0;padding:13px;border:1px solid #e6edf5;background:#f8fafc;border-radius:16px}}.switchrow b{{font-size:13px}}.switchrow span{{display:block;color:#7a8799;font-size:12px;margin-top:2px}}.save{{width:100%;height:48px;border:0;border-radius:16px;background:#101827;color:#fff;font-weight:900;font-size:14px}}.danger{{margin:10px 20px 20px;width:calc(100% - 40px);height:42px;border:1px solid #fee2e2;color:#b91c1c;background:#fff7f7;border-radius:14px;font-weight:800}}.mono{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}}@media(max-width:1100px){{.app{{grid-template-columns:1fr}}.side{{display:none}}.layout{{grid-template-columns:1fr}}.metrics{{grid-template-columns:repeat(2,1fr)}}}}@media(max-width:620px){{.main{{padding:20px 14px}}.topbar{{display:block}}.actions{{margin-top:14px}}.metrics{{grid-template-columns:1fr}}.grid2{{grid-template-columns:1fr}}.ws{{grid-template-columns:42px 1fr}}}}
</style></head><body><div class="app"><aside class="side"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24"><path d="M12 2.5c5.25 0 9.5 4.03 9.5 9s-4.25 9-9.5 9c-1.56 0-3.04-.36-4.34-1.01L3 20.5l1.18-4.3A8.57 8.57 0 0 1 2.5 11.5c0-4.97 4.25-9 9.5-9Z"/></svg></div><div><b>Invite OIDC</b><span>Admin Console</span></div></div><nav class="nav"><a class="active" href="/admin"><i>🏢</i>Workspaces</a><a href="/.well-known/openid-configuration"><i>🔐</i>OIDC Endpoints</a><a href="/jwks"><i>🔑</i>JWKS</a><a href="/healthz"><i>✓</i>Health</a></nav><div class="sidecard"><small>Discovery URL</small><code>{settings.issuer}/.well-known/openid-configuration</code></div></aside><main class="main">{body}</main></div></body></html>""" )


@app.get("/admin")
def admin_page(request: Request, edit: str = ""):
    require_admin(request)
    workspaces = get_workspaces()
    selected = find_workspace_by_id(edit) if edit else None
    ws = selected or Workspace("", "", "", secrets.token_urlsafe(24), secrets.token_urlsafe(18), [], [], "Example", True)
    enabled_count = sum(1 for item in workspaces if item.enabled)
    domain_count = len({domain for item in workspaces for domain in item.allowed_email_domains})
    cards = ""
    for item in workspaces:
        initial = (item.name[:1] or "W").upper()
        first_redirect = item.redirect_uris[0] if item.redirect_uris else "-"
        chips = "".join(f'<span class="chip">@{domain}</span>' for domain in item.allowed_email_domains)
        chips += f'<span class="chip">family_name: {item.family_name}</span>'
        state_class = "on" if item.enabled else "off"
        state_text = "Enabled" if item.enabled else "Disabled"
        cards += f'<article class="ws"><div class="avatar">{initial}</div><div><h3>{item.name}</h3><p>Client ID: <span class="mono">{item.client_id}</span><br>Redirect: <span class="mono">{first_redirect}</span></p><div class="chips">{chips}</div></div><div><span class="state {state_class}">{state_text}</span><br><a class="edit" href="/admin?edit={item.id}">Edit</a></div></article>'
    if not cards:
        cards = '<article class="ws"><div class="avatar">+</div><div><h3>No workspaces yet</h3><p>Create the first ChatGPT/OpenAI SSO workspace.</p></div></article>'
    delete_form = ""
    if selected:
        delete_form = f'<form method="post" action="/admin/delete" onsubmit="return confirm(\'Delete workspace?\')"><input type="hidden" name="id" value="{ws.id}"><button class="danger">删除当前 Workspace</button></form>'
    form = f"""<div class="panel"><form class="form" method="post" action="/admin/save"><h2>{"编辑 Workspace" if selected else "新增 Workspace"}</h2><p>敏感值请妥善保存；配置会写入服务端持久化存储。</p><input type="hidden" name="original_id" value="{selected.id if selected else ""}"><div class="grid2"><div><label>ID</label><input name="id" value="{ws.id}" placeholder="acidtech"></div><div><label>Name</label><input name="name" value="{ws.name}" placeholder="AcidTech Workspace" required></div></div><label>Client ID</label><input name="client_id" value="{ws.client_id}" placeholder="chatgpt-sso-acidtech" required><label>Client Secret</label><input name="client_secret" type="password" value="{ws.client_secret}" required><label>Invite Code</label><input name="invite_code" type="password" value="{ws.invite_code}" required><label>Allowed Email Domains</label><textarea name="allowed_email_domains" rows="3" required>{chr(10).join(ws.allowed_email_domains)}</textarea><label>Redirect / Callback / Fallback URLs</label><textarea name="redirect_uris" rows="5" required>{chr(10).join(ws.redirect_uris)}</textarea><div class="grid2"><div><label>Family Name claim</label><input name="family_name" value="{ws.family_name}"></div><div><label>Issuer</label><input value="{settings.issuer}" disabled></div></div><div class="switchrow"><div><b>启用 Workspace</b><span>关闭后不会参与 OIDC 匹配</span></div><input style="width:auto" type="checkbox" name="enabled" {"checked" if ws.enabled else ""}></div><button class="save">保存 Workspace</button></form>{delete_form}</div>"""
    body = f"""<div class="topbar"><div class="title"><h1>Workspace 管理</h1><p>为每个 OpenAI / ChatGPT Workspace 独立配置 Client、邀请码、邮箱域名和回调地址。</p></div><div class="actions"><a class="btn ghost" href="/.well-known/openid-configuration">查看 Discovery</a><a class="btn primary" href="/admin">+ 新增 Workspace</a></div></div><section class="metrics"><div class="metric"><span>Workspaces</span><b>{len(workspaces)}</b><em>{enabled_count} enabled</em></div><div class="metric"><span>Allowed domains</span><b>{domain_count}</b><em>isolated per workspace</em></div><div class="metric"><span>Signing</span><b>RS256</b><em>active JWKS</em></div><div class="metric"><span>Token TTL</span><b>{settings.token_ttl_seconds}s</b><em>default</em></div></section><section class="layout"><div class="panel"><div class="panelHead"><h2>Workspace 列表</h2><span>按 client_id + redirect_uri 匹配</span></div><div class="list">{cards}</div></div>{form}</section>"""
    return admin_shell(body)


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
