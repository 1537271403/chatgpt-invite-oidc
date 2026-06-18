from urllib.parse import parse_qs, urlparse

import os

os.environ.setdefault("OIDC_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("INVITE_CODE", "test-invite-code")
os.environ.setdefault("ADMIN_PASSWORD", "test-admin-password")
os.environ.setdefault("DATA_DIR", "/tmp/chatgpt-invite-oidc-tests")
os.environ.setdefault("ALLOWED_EMAIL_DOMAINS", "example.com,work.example")
os.environ.setdefault(
    "ALLOWED_REDIRECT_URIS",
    "https://external.auth.openai.com/sso/oidc/test-connection/callback",
)

from fastapi.testclient import TestClient

from app.main import app, settings


client = TestClient(app)


def test_discovery_uses_configured_issuer():
    r = client.get("/.well-known/openid-configuration")
    assert r.status_code == 200
    data = r.json()
    assert data["issuer"] == settings.issuer
    assert data["authorization_endpoint"] == f"{settings.issuer}/authorize"
    assert data["token_endpoint"] == f"{settings.issuer}/token"
    assert data["jwks_uri"] == f"{settings.issuer}/jwks"


def test_authorize_rejects_bad_invite_code():
    r = client.post(
        "/authorize",
        data={
            "client_id": settings.client_id,
            "redirect_uri": settings.allowed_redirect_uris[0],
            "response_type": "code",
            "scope": "openid email profile",
            "state": "abc",
            "nonce": "nonce",
            "email": "alice@example.com",
            "invite_code": "wrong",
        },
    )
    assert r.status_code == 401
    assert "邀请码" in r.text or "invite" in r.text.lower()


def test_authorize_rejects_wrong_email_domain():
    r = client.post(
        "/authorize",
        data={
            "client_id": settings.client_id,
            "redirect_uri": settings.allowed_redirect_uris[0],
            "response_type": "code",
            "scope": "openid email profile",
            "state": "abc",
            "nonce": "nonce",
            "email": "alice@invalid.test",
            "invite_code": settings.invite_code,
        },
    )
    assert r.status_code == 400
    assert "@example.com" in r.text
    assert "@work.example" in r.text


def test_authorize_accepts_each_allowed_email_domain():
    for email in ["alice@example.com", "bob@work.example"]:
        r = client.post(
            "/authorize",
            data={
                "client_id": settings.client_id,
                "redirect_uri": settings.allowed_redirect_uris[0],
                "response_type": "code",
                "scope": "openid email profile",
                "state": "abc",
                "nonce": "nonce",
                "email": email,
                "invite_code": settings.invite_code,
            },
            follow_redirects=False,
        )
        assert r.status_code == 302
        qs = parse_qs(urlparse(r.headers["location"]).query)
        assert qs["code"][0]


def test_legacy_allowed_email_domain_remains_supported(monkeypatch):
    monkeypatch.delenv("ALLOWED_EMAIL_DOMAINS", raising=False)
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAIN", "legacy.example")
    from app.main import Settings

    legacy_settings = Settings()

    assert legacy_settings.allowed_email_domains == ["legacy.example"]


def test_admin_can_create_workspace_and_oidc_uses_workspace_config():
    client.post(
        "/admin/save",
        auth=("admin", settings.admin_password),
        data={
            "id": "team-a",
            "name": "Team A",
            "client_id": "team-a-client",
            "client_secret": "team-a-secret",
            "invite_code": "team-a-invite",
            "allowed_email_domains": "team.example",
            "redirect_uris": "https://external.auth.openai.com/sso/oidc/team-a/callback\nhttps://external.auth.openai.com/sso/oidc/team-a/fallback",
            "family_name": "TeamA",
            "enabled": "on",
        },
        follow_redirects=False,
    )

    bad_redirect = client.get(
        "/authorize",
        params={
            "client_id": "team-a-client",
            "redirect_uri": "https://external.auth.openai.com/sso/oidc/other/callback",
            "response_type": "code",
        },
    )
    assert bad_redirect.status_code == 400

    auth = client.post(
        "/authorize",
        data={
            "client_id": "team-a-client",
            "redirect_uri": "https://external.auth.openai.com/sso/oidc/team-a/fallback",
            "response_type": "code",
            "scope": "openid email profile",
            "state": "state-team-a",
            "nonce": "nonce-team-a",
            "email": "alice@team.example",
            "invite_code": "team-a-invite",
        },
        follow_redirects=False,
    )
    assert auth.status_code == 302
    qs = parse_qs(urlparse(auth.headers["location"]).query)
    code = qs["code"][0]

    wrong_secret = client.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://external.auth.openai.com/sso/oidc/team-a/fallback",
            "client_id": "team-a-client",
            "client_secret": "wrong",
        },
    )
    assert wrong_secret.status_code == 401

    # The failed token exchange must not consume the authorization code.
    token = client.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://external.auth.openai.com/sso/oidc/team-a/fallback",
            "client_id": "team-a-client",
            "client_secret": "team-a-secret",
        },
    )
    assert token.status_code == 200
    access_token = token.json()["access_token"]
    claims = client.get("/userinfo", headers={"Authorization": f"Bearer {access_token}"}).json()
    assert claims["email"] == "alice@team.example"
    assert claims["family_name"] == "TeamA"


def test_authorize_issues_code_and_token_contains_required_claims():
    auth = client.post(
        "/authorize",
        data={
            "client_id": settings.client_id,
            "redirect_uri": settings.allowed_redirect_uris[0],
            "response_type": "code",
            "scope": "openid email profile",
            "state": "state-123",
            "nonce": "nonce-123",
            "email": "alice.smith@example.com",
            "invite_code": settings.invite_code,
        },
        follow_redirects=False,
    )
    assert auth.status_code == 302
    loc = auth.headers["location"]
    qs = parse_qs(urlparse(loc).query)
    assert qs["state"] == ["state-123"]
    code = qs["code"][0]

    token = client.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": settings.allowed_redirect_uris[0],
            "client_id": settings.client_id,
            "client_secret": settings.client_secret,
        },
    )
    assert token.status_code == 200
    body = token.json()
    assert body["token_type"] == "Bearer"
    assert body["access_token"]
    assert body["id_token"]

    userinfo = client.get("/userinfo", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert userinfo.status_code == 200
    claims = userinfo.json()
    assert claims["sub"] == "alice.smith@example.com"
    assert claims["email"] == "alice.smith@example.com"
    assert claims["email_verified"] is True
    assert claims["given_name"] == "alice.smith"
    assert claims["family_name"] == "Example"


def test_code_is_single_use():
    auth = client.post(
        "/authorize",
        data={
            "client_id": settings.client_id,
            "redirect_uri": settings.allowed_redirect_uris[0],
            "response_type": "code",
            "scope": "openid email profile",
            "state": "state",
            "email": "bob@example.com",
            "invite_code": settings.invite_code,
        },
        follow_redirects=False,
    )
    code = parse_qs(urlparse(auth.headers["location"]).query)["code"][0]
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.allowed_redirect_uris[0],
        "client_id": settings.client_id,
        "client_secret": settings.client_secret,
    }
    assert client.post("/token", data=payload).status_code == 200
    assert client.post("/token", data=payload).status_code == 400
