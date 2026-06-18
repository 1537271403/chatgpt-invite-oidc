from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, Form, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


@dataclass
class Settings:
    issuer: str = os.getenv("OIDC_ISSUER", "https://oidc.example.com").rstrip("/")
    client_id: str = os.getenv("OIDC_CLIENT_ID", "chatgpt-sso")
    client_secret: str = os.getenv("OIDC_CLIENT_SECRET", "")
    invite_code: str = os.getenv("INVITE_CODE", "")
    allowed_email_domains: list[str] = None  # type: ignore[assignment]
    allowed_redirect_uris: list[str] = None  # type: ignore[assignment]
    code_ttl_seconds: int = int(os.getenv("CODE_TTL_SECONDS", "300"))
    token_ttl_seconds: int = int(os.getenv("TOKEN_TTL_SECONDS", "3600"))
    rate_limit_window_seconds: int = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
    rate_limit_max_attempts: int = int(os.getenv("RATE_LIMIT_MAX_ATTEMPTS", "10"))
    data_dir: Path = Path(os.getenv("DATA_DIR", "/data"))

    def __post_init__(self):
        domains = os.getenv("ALLOWED_EMAIL_DOMAINS") or os.getenv("ALLOWED_EMAIL_DOMAIN", "example.com")
        self.allowed_email_domains = []
        for domain in domains.split(","):
            domain = domain.strip().lower().lstrip("@")
            if domain and domain not in self.allowed_email_domains:
                self.allowed_email_domains.append(domain)
        redirects = os.getenv("ALLOWED_REDIRECT_URIS", "")
        self.allowed_redirect_uris = [x.strip() for x in redirects.split(",") if x.strip()]
        missing = []
        if not self.client_secret:
            missing.append("OIDC_CLIENT_SECRET")
        if not self.invite_code:
            missing.append("INVITE_CODE")
        if not self.allowed_redirect_uris:
            missing.append("ALLOWED_REDIRECT_URIS")
        if missing:
            raise RuntimeError("Missing required environment variable(s): " + ", ".join(missing))


settings = Settings()
app = FastAPI(title="ChatGPT Invite OIDC", version="0.1.0")
security = HTTPBearer(auto_error=False)

codes: dict[str, dict] = {}
access_tokens: dict[str, dict] = {}
rate_buckets: dict[str, list[float]] = {}


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
    private_key.public_key()
    .public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
).hexdigest()[:16]


def jwk() -> dict:
    return {
        "kty": "RSA",
        "use": "sig",
        "kid": kid,
        "alg": "RS256",
        "n": _b64url_uint(public_numbers.n),
        "e": _b64url_uint(public_numbers.e),
    }


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


def validate_client(client_id: str, redirect_uri: str):
    if client_id != settings.client_id:
        raise HTTPException(status_code=400, detail="invalid client_id")
    if redirect_uri not in settings.allowed_redirect_uris:
        raise HTTPException(status_code=400, detail="invalid redirect_uri")


def allowed_domains_text() -> str:
    return ", ".join(f"@{domain}" for domain in settings.allowed_email_domains)


def email_domain_allowed(email: str) -> bool:
    return any(email.endswith("@" + domain) for domain in settings.allowed_email_domains)


def make_claims(email: str) -> dict:
    local = email.split("@", 1)[0]
    return {
        "sub": email,
        "email": email,
        "email_verified": True,
        "given_name": local,
        "family_name": "Example",
        "name": local,
        "preferred_username": local,
    }


def html_login(params: dict, error: str | None = None) -> HTMLResponse:
    hidden = "".join(
        f'<input type="hidden" name="{k}" value="{str(v).replace("&", "&amp;").replace(chr(34), "&quot;")}">'
        for k, v in params.items()
    )
    error_html = f'<div class="err">{error}</div>' if error else ""
    domains = allowed_domains_text()
    placeholder_domain = settings.allowed_email_domains[0]
    return HTMLResponse(
        f"""
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT SSO</title><style>
body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}}
.card{{width:min(92vw,420px);background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}}
h1{{margin:0 0 8px;font-size:26px}}p{{color:#94a3b8}}label{{display:block;margin:16px 0 6px;color:#cbd5e1}}input{{box-sizing:border-box;width:100%;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#020617;color:#fff;font-size:16px}}
button{{width:100%;margin-top:22px;padding:12px;border:0;border-radius:10px;background:#10a37f;color:white;font-weight:700;font-size:16px;cursor:pointer}}.err{{background:#7f1d1d;color:#fecaca;padding:10px;border-radius:10px;margin:12px 0}}small{{color:#64748b}}
</style></head><body><main class="card"><h1>ChatGPT SSO</h1><p>输入 {domains} 邮箱和邀请码登录。</p>{error_html}
<form method="post" action="/authorize">{hidden}
<label>Email</label><input name="email" type="email" placeholder="you@{placeholder_domain}" required autofocus>
<label>Invite code</label><input name="invite_code" type="password" required>
<button type="submit">Continue to ChatGPT</button></form><p><small>No account registration required.</small></p></main></body></html>
"""
    )


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/.well-known/openid-configuration")
def discovery():
    return {
        "issuer": settings.issuer,
        "authorization_endpoint": f"{settings.issuer}/authorize",
        "token_endpoint": f"{settings.issuer}/token",
        "userinfo_endpoint": f"{settings.issuer}/userinfo",
        "jwks_uri": f"{settings.issuer}/jwks",
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "email", "profile"],
        "claims_supported": ["sub", "email", "email_verified", "given_name", "family_name", "name", "preferred_username"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
    }


@app.get("/jwks")
def jwks():
    return {"keys": [jwk()]}


@app.get("/authorize", response_class=HTMLResponse)
def authorize_form(
    client_id: str,
    redirect_uri: str,
    response_type: str,
    scope: str = "openid email profile",
    state: str | None = None,
    nonce: str | None = None,
):
    validate_client(client_id, redirect_uri)
    if response_type != "code":
        raise HTTPException(status_code=400, detail="unsupported response_type")
    return html_login(locals())


@app.post("/authorize")
def authorize_submit(
    request: Request,
    client_id: Annotated[str, Form()],
    redirect_uri: Annotated[str, Form()],
    response_type: Annotated[str, Form()],
    scope: Annotated[str, Form()] = "openid email profile",
    state: Annotated[str | None, Form()] = None,
    nonce: Annotated[str | None, Form()] = None,
    email: Annotated[str, Form()] = "",
    invite_code: Annotated[str, Form()] = "",
):
    check_rate_limit(request)
    validate_client(client_id, redirect_uri)
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": response_type, "scope": scope, "state": state or "", "nonce": nonce or ""}
    email = email.strip().lower()
    if invite_code != settings.invite_code:
        response = html_login(params, "邀请码不正确 / Invalid invite code")
        response.status_code = 401
        return response
    if not email_domain_allowed(email):
        response = html_login(params, f"邮箱必须是以下域名之一 / Email must use one of: {allowed_domains_text()}")
        response.status_code = 400
        return response
    if response_type != "code":
        raise HTTPException(status_code=400, detail="unsupported response_type")
    code = secrets.token_urlsafe(32)
    codes[code] = {"email": email, "redirect_uri": redirect_uri, "client_id": client_id, "scope": scope, "nonce": nonce, "expires_at": time.time() + settings.code_ttl_seconds}
    query = {"code": code}
    if state:
        query["state"] = state
    return RedirectResponse(redirect_uri + "?" + urlencode(query), status_code=302)


def basic_client_secret(authorization: str | None):
    if not authorization or not authorization.lower().startswith("basic "):
        return None, None
    raw = base64.b64decode(authorization.split(" ", 1)[1]).decode()
    client_id, client_secret = raw.split(":", 1)
    return client_id, client_secret


@app.post("/token")
def token(
    grant_type: Annotated[str, Form()],
    code: Annotated[str, Form()],
    redirect_uri: Annotated[str, Form()],
    client_id: Annotated[str | None, Form()] = None,
    client_secret: Annotated[str | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
):
    basic_id, basic_secret = basic_client_secret(authorization)
    client_id = client_id or basic_id
    client_secret = client_secret or basic_secret
    if client_id != settings.client_id or client_secret != settings.client_secret:
        raise HTTPException(status_code=401, detail="invalid_client")
    if grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="unsupported_grant_type")
    item = codes.pop(code, None)
    if not item or item["expires_at"] < time.time():
        raise HTTPException(status_code=400, detail="invalid_grant")
    if item["redirect_uri"] != redirect_uri:
        raise HTTPException(status_code=400, detail="invalid_grant")
    now = int(time.time())
    claims = make_claims(item["email"])
    id_payload = {
        **claims,
        "iss": settings.issuer,
        "aud": settings.client_id,
        "iat": now,
        "exp": now + settings.token_ttl_seconds,
    }
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
