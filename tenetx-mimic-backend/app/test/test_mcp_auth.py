"""Tests for app/mcp/auth.py McpAccessTokenVerifier.

Hermetic: no real Firestore, no network. A hand-rolled fake Firestore client
(``_FakeDb``) backs the ``collection().where().limit().stream()`` chain the
verifier walks, and a fixed ``now_fn`` makes expiry deterministic. Async
``verify_token`` is driven via ``asyncio.run`` — the same pattern
``test_auth.py`` uses, so pytest-asyncio is not required.

``expiresAt`` fixtures use the EXACT frontend shape emitted by
``src/lib/mcpTokens.ts`` (``new Date(...).toISOString()`` -> a millisecond,
``Z``-suffixed ISO string like ``2099-01-01T00:00:00.000Z``) so the Z-normalize
+ tz-aware comparison is exercised end-to-end.
"""
from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any, Optional

from app.mcp.auth import McpAccessTokenVerifier

_PLAINTEXT = "ttx_pat_" + "a" * 40
_HASH = hashlib.sha256(_PLAINTEXT.encode()).hexdigest()

# Fixed "now" so expiry cases are deterministic.
_NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


class _FakeRef:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.updated: Optional[dict[str, Any]] = None

    def update(self, data: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("firestore update blew up")
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

    def where(self, *_args: Any, **_kwargs: Any) -> "_FakeQuery":
        return self

    def limit(self, _n: int) -> "_FakeQuery":
        return self

    def stream(self) -> Any:
        return iter(self._snaps)


class _FakeCollection:
    def __init__(self, snaps: list[_FakeSnap]) -> None:
        self._snaps = snaps

    def where(self, *_args: Any, **_kwargs: Any) -> _FakeQuery:
        # Accept both positional args and filter= kwarg (FieldFilter).
        return _FakeQuery(self._snaps)


class _FakeDb:
    def __init__(self, snaps: list[_FakeSnap], expected_collection: str = "mcp_tokens") -> None:
        self._snaps = snaps
        self._expected = expected_collection

    def collection(self, name: str) -> _FakeCollection:
        assert name == self._expected
        return _FakeCollection(self._snaps)


def _make_snap(**overrides: Any) -> _FakeSnap:
    data: dict[str, Any] = {
        "name": "ci-token",
        "tokenHash": _HASH,
        "tokenPrefix": _PLAINTEXT[:12],
        "scopes": ["read", "write"],
        "expiresAt": "2099-01-01T00:00:00.000Z",
        "lastUsedAt": None,
        "revoked": False,
        "createdAt": "2026-01-01T00:00:00.000Z",
    }
    ref = overrides.pop("_ref", None) or _FakeRef()
    data.update(overrides)
    return _FakeSnap("doc-123", data, ref)


def _verify(snaps: list[_FakeSnap], token: str = _PLAINTEXT) -> Any:
    verifier = McpAccessTokenVerifier(db=_FakeDb(snaps), now_fn=lambda: _NOW)
    return asyncio.run(verifier.verify_token(token))


def test_hash_matches_frontend_sha256_lowercase_hex() -> None:
    # Given a known plaintext, When hashed, Then it equals stdlib sha256 hex.
    assert McpAccessTokenVerifier._hash_token(_PLAINTEXT) == _HASH
    assert _HASH == _HASH.lower() and len(_HASH) == 64


def test_valid_unexpired_token_returns_access_token_with_claims() -> None:
    result = _verify([_make_snap()])

    assert result is not None
    assert result.client_id == "doc-123"
    assert result.scopes == []  # no enforcement in v1
    assert result.claims == {
        "token_id": "doc-123",
        "scopes": ["read", "write"],
        "name": "ci-token",
    }


def test_revoked_token_returns_none() -> None:
    assert _verify([_make_snap(revoked=True)]) is None


def test_expired_z_shaped_timestamp_returns_none() -> None:
    # expiresAt in exact frontend Z-suffixed shape, in the past relative to _NOW.
    assert _verify([_make_snap(expiresAt="2020-01-01T00:00:00.000Z")]) is None


def test_z_shaped_future_expiry_does_not_typeerror_and_verifies() -> None:
    # Aware/naive regression: Z-suffix must normalize + compare aware, not raise.
    result = _verify([_make_snap(expiresAt="2099-12-31T23:59:59.999Z")])
    assert result is not None


def test_missing_hash_no_match_returns_none() -> None:
    assert _verify([], token="ttx_pat_" + "b" * 40) is None


def test_missing_expiresAt_field_fails_closed() -> None:
    assert _verify([_make_snap(expiresAt=None)]) is None


def test_firestore_exception_returns_none_never_raises() -> None:
    class _BoomDb:
        def collection(self, _name: str) -> Any:
            raise RuntimeError("firestore unavailable")

    verifier = McpAccessTokenVerifier(db=_BoomDb(), now_fn=lambda: _NOW)
    assert asyncio.run(verifier.verify_token(_PLAINTEXT)) is None


def test_none_firestore_client_fails_closed() -> None:
    verifier = McpAccessTokenVerifier(db=None, now_fn=lambda: _NOW)
    # get_mcp_firestore returns None when Keycloak/WIF unconfigured -> deny.
    import app.mcp.auth as auth_module

    original = auth_module.get_mcp_firestore
    auth_module.get_mcp_firestore = lambda: None  # type: ignore[assignment]
    try:
        assert asyncio.run(verifier.verify_token(_PLAINTEXT)) is None
    finally:
        auth_module.get_mcp_firestore = original  # type: ignore[assignment]


def test_last_used_at_write_failure_still_returns_access_token() -> None:
    failing_ref = _FakeRef(fail=True)
    result = _verify([_make_snap(_ref=failing_ref)])

    assert result is not None
    assert result.claims["token_id"] == "doc-123"


def test_last_used_at_written_in_z_suffixed_shape_on_success() -> None:
    ref = _FakeRef()
    result = _verify([_make_snap(_ref=ref)])

    assert result is not None
    assert ref.updated is not None
    stamp = ref.updated["lastUsedAt"]
    assert stamp.endswith("Z") and "+00:00" not in stamp


def test_naive_expiry_string_is_treated_as_utc() -> None:
    # A stored ISO string without offset (defensive): normalized to aware-UTC.
    future_naive = "2099-01-01T00:00:00"
    assert _verify([_make_snap(expiresAt=future_naive)]) is not None
    past_naive = "2020-01-01T00:00:00"
    assert _verify([_make_snap(expiresAt=past_naive)]) is None


def test_default_now_fn_is_tz_aware() -> None:
    verifier = McpAccessTokenVerifier()
    now = verifier._now_fn()
    assert isinstance(now, datetime)
    assert now.tzinfo is not None


def test_server_wires_verifier_into_fastmcp_auth() -> None:
    from app.mcp.server import mcp

    assert isinstance(mcp.auth, McpAccessTokenVerifier)
