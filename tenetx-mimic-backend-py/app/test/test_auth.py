"""Tests for app/auth.py — Firebase Admin init + the FastAPI auth dependency,
ported from tenetx-mimic-backend/src/index.ts:42-134.

No network and no live Firebase project: init is exercised with the credential
constructor + initialize_app mocked (so the exact authorized_user credential dict
is asserted without a token exchange), and the dependency is exercised with
firebase_auth.verify_id_token mocked. The async dependency/handler are driven via
asyncio.run, so pytest-asyncio is not required. The end-to-end TestClient case is
skipped when httpx is absent; the direct dependency + handler cases already assert
the exact Node 401 status codes and byte-compact {"error": ...} bodies.
"""
from __future__ import annotations

import asyncio

import firebase_admin
import pytest

from app import auth

REFRESH_TOKEN_ENV = "FIREBASE_REFRESH_TOKEN"


def _delete_default_app_if_present() -> None:
    try:
        existing = firebase_admin.get_app()
    except ValueError:
        return
    firebase_admin.delete_app(existing)


@pytest.fixture
def clean_firebase():
    _delete_default_app_if_present()
    yield
    _delete_default_app_if_present()


class _FakeHeaders:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, key: str):
        return self._mapping.get(key)


class _FakeRequest:
    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = _FakeHeaders(headers)


def _bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def _run_dependency(headers: dict[str, str]) -> auth.AuthenticatedUser:
    return asyncio.run(auth.require_tenetx_user(_FakeRequest(headers)))


# ---------------------------------------------------------------------------
# init_firebase_app — plain init smoke tests (no HTTP, no network)
# ---------------------------------------------------------------------------
def test_init_returns_none_when_refresh_token_absent(monkeypatch, clean_firebase):
    monkeypatch.delenv(REFRESH_TOKEN_ENV, raising=False)
    assert auth.init_firebase_app() is None
    with pytest.raises(ValueError):
        firebase_admin.get_app()  # warn-and-continue: no default app was created


def test_init_wires_authorized_user_credential(monkeypatch, clean_firebase):
    monkeypatch.setenv(REFRESH_TOKEN_ENV, "test-refresh-token-value")
    captured: dict[str, object] = {}

    def fake_refresh_token(data):
        captured["cred_dict"] = data
        return "FAKE_CRED"

    def fake_initialize_app(cred, options):
        captured["cred"] = cred
        captured["options"] = options
        return "FAKE_APP"

    monkeypatch.setattr("app.auth.credentials.RefreshToken", fake_refresh_token)
    monkeypatch.setattr("app.auth.firebase_admin.initialize_app", fake_initialize_app)

    assert auth.init_firebase_app() == "FAKE_APP"
    assert captured["cred_dict"] == {
        "type": "authorized_user",
        "client_id": auth.FIREBASE_TOOLS_CLIENT_ID,
        "client_secret": auth.FIREBASE_TOOLS_CLIENT_SECRET,
        "refresh_token": "test-refresh-token-value",
    }
    assert captured["cred"] == "FAKE_CRED"
    assert captured["options"] == {"projectId": "tenetx-qa-scores"}


def test_init_is_idempotent_when_app_exists(monkeypatch):
    sentinel = object()
    monkeypatch.setattr("app.auth.firebase_admin.get_app", lambda: sentinel)
    init_calls: list[object] = []
    monkeypatch.setattr(
        "app.auth.firebase_admin.initialize_app",
        lambda *a, **k: init_calls.append((a, k)),
    )
    assert auth.init_firebase_app() is sentinel
    assert init_calls == []


def test_init_exits_when_initialize_raises(monkeypatch, clean_firebase):
    monkeypatch.setenv(REFRESH_TOKEN_ENV, "any-present-value")
    monkeypatch.setattr("app.auth.credentials.RefreshToken", lambda data: "CRED")

    def boom(*_a, **_k):
        raise RuntimeError("initialize_app blew up")

    monkeypatch.setattr("app.auth.firebase_admin.initialize_app", boom)
    with pytest.raises(SystemExit) as exc_info:
        auth.init_firebase_app()
    assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# require_tenetx_user — the FastAPI auth dependency (index.ts:95-134)
# ---------------------------------------------------------------------------
def test_dependency_rejects_missing_authorization_header():
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency({})
    assert exc_info.value.status_code == 401
    assert exc_info.value.payload == {"error": "Missing or invalid Authorization header"}


def test_dependency_rejects_non_bearer_prefix():
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency({"authorization": "Basic dXNlcjpwYXNz"})
    assert exc_info.value.payload == {"error": "Missing or invalid Authorization header"}


def test_dependency_accepts_verified_tenetx_email(monkeypatch):
    captured: dict[str, str] = {}

    def fake_verify(token):
        captured["token"] = token
        return {"uid": "uid-123", "email": "qa@tenetx.ai", "email_verified": True}

    monkeypatch.setattr("app.auth.firebase_auth.verify_id_token", fake_verify)
    user = _run_dependency(_bearer("good-id-token"))
    assert captured["token"] == "good-id-token"  # "Bearer " prefix stripped
    assert user == auth.AuthenticatedUser(
        uid="uid-123", email="qa@tenetx.ai", email_verified=True
    )


def test_dependency_rejects_wrong_email_domain(monkeypatch):
    monkeypatch.setattr(
        "app.auth.firebase_auth.verify_id_token",
        lambda _t: {"uid": "uid-9", "email": "attacker@evil.com", "email_verified": True},
    )
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency(_bearer("token"))
    assert exc_info.value.payload == {
        "error": "Unauthorized: email must be @tenetx.ai and verified"
    }


def test_dependency_rejects_unverified_email(monkeypatch):
    monkeypatch.setattr(
        "app.auth.firebase_auth.verify_id_token",
        lambda _t: {"uid": "uid-8", "email": "qa@tenetx.ai", "email_verified": False},
    )
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency(_bearer("token"))
    assert exc_info.value.payload == {
        "error": "Unauthorized: email must be @tenetx.ai and verified"
    }


def test_dependency_rejects_missing_email_claim(monkeypatch):
    monkeypatch.setattr(
        "app.auth.firebase_auth.verify_id_token", lambda _t: {"uid": "uid-7"}
    )
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency(_bearer("token"))
    assert exc_info.value.payload == {
        "error": "Unauthorized: email must be @tenetx.ai and verified"
    }


def test_dependency_rejects_invalid_or_expired_token(monkeypatch):
    def boom(_token):
        raise ValueError("Token has expired")

    monkeypatch.setattr("app.auth.firebase_auth.verify_id_token", boom)
    with pytest.raises(auth.AuthError) as exc_info:
        _run_dependency(_bearer("expired-token"))
    assert exc_info.value.payload == {"error": "Invalid or expired token"}


# ---------------------------------------------------------------------------
# auth_error_handler — byte-exact {"error": ...} body (Express res.json parity)
# ---------------------------------------------------------------------------
def test_auth_error_handler_renders_compact_error_body():
    err = auth.AuthError(401, {"error": "Missing or invalid Authorization header"})
    response = asyncio.run(auth.auth_error_handler(_FakeRequest({}), err))
    assert response.status_code == 401
    assert response.media_type == "application/json"
    assert response.body == b'{"error":"Missing or invalid Authorization header"}'


# ---------------------------------------------------------------------------
# End-to-end wire parity through FastAPI (skipped if httpx is unavailable)
# ---------------------------------------------------------------------------
def test_registered_dependency_returns_node_401_shapes_end_to_end(monkeypatch):
    pytest.importorskip("httpx")
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    test_app = FastAPI()
    auth.register_auth(test_app)

    @test_app.post("/_protected")
    async def _protected(
        user: auth.AuthenticatedUser = Depends(auth.require_tenetx_user),
    ) -> dict[str, str]:
        return {"email": user.email}

    client = TestClient(test_app)

    missing = client.post("/_protected")
    assert missing.status_code == 401
    assert missing.json() == {"error": "Missing or invalid Authorization header"}

    monkeypatch.setattr(
        "app.auth.firebase_auth.verify_id_token",
        lambda _t: {"uid": "uid-1", "email": "qa@tenetx.ai", "email_verified": True},
    )
    ok = client.post("/_protected", headers=_bearer("valid"))
    assert ok.status_code == 200
    assert ok.json() == {"email": "qa@tenetx.ai"}

    monkeypatch.setattr(
        "app.auth.firebase_auth.verify_id_token",
        lambda _t: {"uid": "uid-2", "email": "x@evil.com", "email_verified": True},
    )
    wrong_domain = client.post("/_protected", headers=_bearer("valid"))
    assert wrong_domain.status_code == 401
    assert wrong_domain.json() == {
        "error": "Unauthorized: email must be @tenetx.ai and verified"
    }
