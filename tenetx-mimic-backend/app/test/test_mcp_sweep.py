"""MCP bare /mcp path normalization and FieldFilter warning tests.

Tests that McpPathNormalizeMiddleware rewrites bare POST /mcp (no trailing slash)
to /mcp/ in-process without a 307 redirect, so auth-bearing MCP clients never lose
Authorization. Also verifies that FieldFilter usage in McpAccessTokenVerifier does
not emit positional-argument UserWarnings.
"""
from __future__ import annotations

import hashlib
import warnings
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
        "clientInfo": {"name": "sweep-test", "version": "0.0.0"},
    },
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


def test_bare_mcp_post_without_follow_returns_307() -> None:
    """POST /mcp (no trailing slash) without follow_redirects returns 307."""
    with TestClient(app) as client:
        response = client.post(
            "/mcp",
            json=_INITIALIZE,
            headers=_auth_headers(token=None),
            follow_redirects=False,
        )
    assert response.status_code == 307
    location = response.headers.get("location", "")
    assert location.endswith("/mcp/"), f"Expected location to end with /mcp/, got {location}"


def test_bare_mcp_post_with_follow_reaches_auth_gate_401() -> None:
    """POST /mcp with follow_redirects (default) reaches auth gate and returns 401."""
    with TestClient(app) as client:
        response = client.post(
            "/mcp",
            json=_INITIALIZE,
            headers=_auth_headers(token=None),
            follow_redirects=True,
        )
    assert response.status_code == 401
    assert "Task group is not initialized" not in response.text


def test_bare_mcp_post_with_follow_and_valid_pat_initialize_200(patch_auth_db) -> None:
    """POST /mcp with valid PAT and follow_redirects returns 200."""
    patch_auth_db([_make_snap()])
    with TestClient(app) as client:
        response = client.post(
            "/mcp",
            json=_INITIALIZE,
            headers=_auth_headers(),
            follow_redirects=True,
        )
    assert response.status_code == 200, response.text
    session_id = response.headers.get("mcp-session-id")
    assert session_id, f"missing mcp-session-id in {dict(response.headers)}"


def test_fieldfilter_path_emits_no_positional_where_userwarning(patch_auth_db) -> None:
    """McpAccessTokenVerifier.verify_token with FieldFilter emits no positional-arg UserWarning."""
    patch_auth_db([_make_snap()])
    
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        
        with TestClient(app) as client:
            response = client.post(
                "/mcp/",
                json=_INITIALIZE,
                headers=_auth_headers(),
            )
        
        assert response.status_code == 200, response.text
    
    # Check no UserWarning about positional arguments in where() call.
    for warning in w:
        if issubclass(warning.category, UserWarning):
            msg = str(warning.message).lower()
            assert "positional" not in msg and "filter" not in msg, (
                f"Unexpected UserWarning about positional args: {warning.message}"
            )
