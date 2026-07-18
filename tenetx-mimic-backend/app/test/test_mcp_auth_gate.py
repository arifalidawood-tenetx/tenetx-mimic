"""HTTP auth-gate integration tests for /mcp (working-mcp-pat todo 5).

Always drives the app through ``with TestClient(app) as client:`` so the ASGI
lifespan (and therefore the StreamableHTTP session manager) is active. Do NOT
copy the bare ``TestClient(app)`` pattern from the SAML suite — that skips
lifespan and would 500 on a dead session manager before auth can even run.

Auth is fail-closed via ``McpAccessTokenVerifier``. These tests monkeypatch
``app.mcp.auth.get_mcp_firestore`` (the name the verifier module binds) with an
in-memory fake so no real Firebase credentials are needed. The verifier instance
wired into ``FastMCP(auth=...)`` resolves the client lazily per-request, so the
patch takes effect without rebuilding the mounted ASGI app.

HTTP mode is the production default (stateful Streamable HTTP — see
``app.mcp.lifespan.get_mcp_http_app``). Valid-PAT flows therefore: initialize →
capture ``mcp-session-id`` → tools/list on the same session.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

import pytest

pytest.importorskip("fastmcp")

from fastapi.testclient import TestClient
from google.cloud.firestore_v1.base_query import FieldFilter

from app.main import app

_PLAINTEXT = "ttx_pat_" + "a" * 40
_HASH = hashlib.sha256(_PLAINTEXT.encode()).hexdigest()
_ACCEPT = "application/json, text/event-stream"
_NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

_INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "auth-gate-test", "version": "0.0.0"},
    },
}

_TOOLS_LIST = {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {},
}


class _FakeRef:
    def __init__(self) -> None:
        self.updated: Optional[dict[str, Any]] = None

    def update(self, data: dict[str, Any]) -> None:
        self.updated = data


class _FakeSnap:
    def __init__(self, doc_id: str, data: dict[str, Any], ref: _FakeRef) -> None:
        self.id = doc_id
        self._data = data
        self.reference = ref

    def to_dict(self) -> dict[str, Any]:
        return self._data


class _FakeQuery:
    def __init__(self, snaps: list[_FakeSnap]) -> None:
        self._snaps = snaps

    def limit(self, _n: int) -> "_FakeQuery":
        return self

    def stream(self) -> list[_FakeSnap]:
        return list(self._snaps)


class _FakeCollection:
    def __init__(self, snaps: list[_FakeSnap]) -> None:
        self._snaps = snaps

    def where(self, *args: Any, **kwargs: Any) -> _FakeQuery:
        # Support both positional args and filter= kwarg (FieldFilter).
        field = None
        op = None
        value = None
        
        if "filter" in kwargs:
            # Unwrap FieldFilter(field_path, op_string, value).
            ff = kwargs["filter"]
            if isinstance(ff, FieldFilter):
                field = ff.field_path
                op = ff.op_string
                value = ff.value
        else:
            # Fallback to positional or field_path/op_string/value kwargs.
            field = args[0] if args else kwargs.get("field_path")
            op = args[1] if len(args) > 1 else kwargs.get("op_string")
            value = args[2] if len(args) > 2 else kwargs.get("value")
        
        if field == "tokenHash" and op == "==":
            matched = [s for s in self._snaps if s.to_dict().get("tokenHash") == value]
            return _FakeQuery(matched)
        return _FakeQuery(self._snaps)


class _FakeDb:
    def __init__(self, snaps: list[_FakeSnap]) -> None:
        self._snaps = snaps

    def collection(self, name: str) -> _FakeCollection:
        assert name == "mcp_tokens"
        return _FakeCollection(self._snaps)


def _make_snap(**overrides: Any) -> _FakeSnap:
    data: dict[str, Any] = {
        "tokenHash": _HASH,
        "revoked": False,
        "expiresAt": "2099-12-31T00:00:00.000Z",
        "scopes": ["mimic:read"],
        "name": "test-token",
    }
    data.update(overrides)
    return _FakeSnap("tok-doc-1", data, _FakeRef())


@pytest.fixture
def patch_auth_db(monkeypatch: pytest.MonkeyPatch):
    """Install a fake mcp_tokens Firestore for the verifier."""

    def _install(snaps: list[_FakeSnap]) -> _FakeDb:
        db = _FakeDb(snaps)
        import app.mcp.auth as auth_module

        monkeypatch.setattr(auth_module, "get_mcp_firestore", lambda: db)
        from app.mcp.server import mcp

        verifier = mcp.auth
        assert verifier is not None
        monkeypatch.setattr(verifier, "_now_fn", lambda: _NOW)
        return db

    return _install


def _auth_headers(token: str | None = _PLAINTEXT, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    headers = {"Accept": _ACCEPT}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if extra:
        headers.update(extra)
    return headers


def _post_mcp(client: TestClient, body: dict[str, Any], headers: dict[str, str]):
    return client.post("/mcp/", json=body, headers=headers)


def _parse_sse_or_json(response) -> Any:
    """Parse a Streamable HTTP response that may be JSON or SSE data frames."""
    ctype = response.headers.get("content-type", "")
    text = response.text
    if "application/json" in ctype:
        return response.json()
    payloads: list[Any] = []
    for line in text.splitlines():
        if line.startswith("data:"):
            raw = line[len("data:") :].strip()
            if raw:
                payloads.append(json.loads(raw))
    if len(payloads) == 1:
        return payloads[0]
    return payloads


def test_no_authorization_returns_401(patch_auth_db) -> None:
    patch_auth_db([_make_snap()])
    with TestClient(app) as client:
        response = _post_mcp(client, _INITIALIZE, _auth_headers(token=None))
    assert response.status_code == 401


def test_bogus_bearer_returns_401(patch_auth_db) -> None:
    patch_auth_db([_make_snap()])
    with TestClient(app) as client:
        response = _post_mcp(client, _INITIALIZE, _auth_headers(token="ttx_pat_" + "b" * 40))
    assert response.status_code == 401


def test_revoked_pat_returns_401(patch_auth_db) -> None:
    patch_auth_db([_make_snap(revoked=True)])
    with TestClient(app) as client:
        response = _post_mcp(client, _INITIALIZE, _auth_headers())
    assert response.status_code == 401


def test_expired_pat_returns_401(patch_auth_db) -> None:
    patch_auth_db([_make_snap(expiresAt="2020-01-01T00:00:00.000Z")])
    with TestClient(app) as client:
        response = _post_mcp(client, _INITIALIZE, _auth_headers())
    assert response.status_code == 401


def test_valid_pat_initialize_and_tools_list_succeed(patch_auth_db) -> None:
    patch_auth_db([_make_snap()])
    with TestClient(app) as client:
        init_resp = _post_mcp(client, _INITIALIZE, _auth_headers())
        assert init_resp.status_code == 200, init_resp.text
        session_id = init_resp.headers.get("mcp-session-id")
        assert session_id, f"missing mcp-session-id in {dict(init_resp.headers)}"

        client.post(
            "/mcp/",
            json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            },
            headers=_auth_headers(extra={"mcp-session-id": session_id}),
        )

        list_resp = _post_mcp(
            client,
            _TOOLS_LIST,
            _auth_headers(extra={"mcp-session-id": session_id}),
        )
        assert list_resp.status_code == 200, list_resp.text
        payload = _parse_sse_or_json(list_resp)
        if isinstance(payload, list):
            payload = next(p for p in payload if isinstance(p, dict) and "result" in p)
        tools = payload["result"]["tools"]
        names = {t["name"] for t in tools}
        assert names == {"mimic_health", "mimic_list_features", "mimic_get_feature"}
        for name in names:
            assert re.match(r"^[a-zA-Z0-9_-]+$", name)
            assert "/" not in name


def test_health_unaffected_by_mcp_auth_gate(patch_auth_db) -> None:
    patch_auth_db([])
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
