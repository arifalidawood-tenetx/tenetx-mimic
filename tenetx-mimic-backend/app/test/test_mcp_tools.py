"""Tests for app/mcp/tools.py — the mimic_* MCP tools + mcp_tool_calls audit log
(working-mcp-pat todo 4).

Fully hermetic: the Firestore client is a hand-rolled in-memory fake injected by
patching ``tools.get_mcp_firestore`` (the name bound INTO the tools module by its
``from ... import`` — patching the source module would not rebind it). No real
Firestore, no emulator, no network, no credentials. The fake records every
``mcp_tool_calls`` write so the audit-field assertions read the exact document the
tool would have persisted.
"""
from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace
from typing import Any, Optional

import pytest

pytest.importorskip("fastmcp")

from app.mcp import tools

TOOL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


# ---------------------------------------------------------------------------
# In-memory Firestore fake
# ---------------------------------------------------------------------------
class _FakeSnapshot:
    def __init__(self, doc_id: str, data: Optional[dict[str, Any]]) -> None:
        self.id = doc_id
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> Optional[dict[str, Any]]:
        return self._data


class _FakeDocRef:
    def __init__(self, doc_id: str, data: Optional[dict[str, Any]]) -> None:
        self._doc_id = doc_id
        self._data = data

    def get(self) -> _FakeSnapshot:
        return _FakeSnapshot(self._doc_id, self._data)


class _FakeCollection:
    def __init__(self, name: str, db: "_FakeFirestore") -> None:
        self._name = name
        self._db = db

    def stream(self) -> list[_FakeSnapshot]:
        return [
            _FakeSnapshot(doc_id, data)
            for doc_id, data in self._db.features.items()
        ]

    def document(self, doc_id: str) -> _FakeDocRef:
        return _FakeDocRef(doc_id, self._db.features.get(doc_id))

    def add(self, payload: dict[str, Any]) -> tuple[Any, Any]:
        if self._db.add_raises is not None:
            raise self._db.add_raises
        self._db.tool_calls.append(payload)
        return (None, SimpleNamespace(id="generated-id"))


class _FakeFirestore:
    def __init__(
        self,
        features: Optional[dict[str, Optional[dict[str, Any]]]] = None,
        add_raises: Optional[Exception] = None,
    ) -> None:
        self.features: dict[str, Optional[dict[str, Any]]] = features or {}
        self.tool_calls: list[dict[str, Any]] = []
        self.add_raises = add_raises

    def collection(self, name: str) -> _FakeCollection:
        return _FakeCollection(name, self)


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> _FakeFirestore:
    db = _FakeFirestore()
    monkeypatch.setattr(tools, "get_mcp_firestore", lambda: db)
    # No auth context by default -> audit records client "unknown" / tokenId None.
    monkeypatch.setattr(tools, "_safe_access_token", lambda: None)
    return db


@pytest.fixture
def no_db(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "get_mcp_firestore", lambda: None)
    monkeypatch.setattr(tools, "_safe_access_token", lambda: None)


# ---------------------------------------------------------------------------
# Tool registration — underscore names, no slash tools
# ---------------------------------------------------------------------------
def test_registered_tool_names_are_underscore_only_no_slash() -> None:
    from app.mcp.server import mcp

    names = {tool.name for tool in asyncio.run(mcp.list_tools())}
    assert names == {"mimic_health", "mimic_list_features", "mimic_get_feature"}
    for name in names:
        assert TOOL_NAME_RE.match(name), f"tool name {name!r} violates ^[a-zA-Z0-9_-]+$"
        assert "/" not in name


def test_no_slash_named_tools_registered() -> None:
    from app.mcp.server import mcp

    names = {tool.name for tool in asyncio.run(mcp.list_tools())}
    assert not any("/" in name for name in names)


# ---------------------------------------------------------------------------
# mimic_health
# ---------------------------------------------------------------------------
def test_health_reports_firestore_configured_true(fake_db: _FakeFirestore) -> None:
    status, payload = tools._health()
    assert status == 200
    assert payload["status"] == "ok"
    assert payload["firestoreConfigured"] is True


def test_health_reports_firestore_configured_false(no_db: None) -> None:
    status, payload = tools._health()
    assert status == 200
    assert payload["firestoreConfigured"] is False


# ---------------------------------------------------------------------------
# mimic_list_features
# ---------------------------------------------------------------------------
def test_list_features_maps_docs_and_sanitizes_malformed(
    fake_db: _FakeFirestore,
) -> None:
    fake_db.features = {
        "good": {
            "ticketId": "TEN-1",
            "featureSlug": "saml-login",
            "attemptNumber": 3,
            "title": "SAML login",
            "status": "done",
            "routePath": "/saml/login",
        },
        # Malformed: wrong types / missing fields -> frontend-parity defaults.
        "bad": {"attemptNumber": "not-an-int", "status": "bogus"},
    }
    status, payload = tools._list_features()

    assert status == 200
    assert payload["count"] == 2
    by_id = {f["id"]: f for f in payload["features"]}

    good = by_id["good"]
    assert good["ticketId"] == "TEN-1"
    assert good["attemptNumber"] == 3
    assert good["status"] == "done"

    bad = by_id["bad"]
    assert bad["ticketId"] == "UNKNOWN"
    assert bad["featureSlug"] == ""
    assert bad["attemptNumber"] == 0
    assert bad["title"] == "Untitled feature"
    assert bad["status"] == "planned"
    assert bad["routePath"] == "/"


def test_list_features_empty_when_no_client(no_db: None) -> None:
    status, payload = tools._list_features()
    assert status == 200
    assert payload == {"features": [], "count": 0, "firestoreConfigured": False}


def test_attempt_number_bool_is_not_accepted_as_int(fake_db: _FakeFirestore) -> None:
    """bool is an int subclass; a True must sanitize to 0, not be kept as an int."""
    fake_db.features = {"b": {"attemptNumber": True}}
    _, payload = tools._list_features()
    assert payload["features"][0]["attemptNumber"] == 0


# ---------------------------------------------------------------------------
# mimic_get_feature
# ---------------------------------------------------------------------------
def test_get_feature_found_returns_full_doc(fake_db: _FakeFirestore) -> None:
    fake_db.features = {"f1": {"title": "X", "ticketId": "TEN-9", "extra": "kept"}}
    status, payload = tools._get_feature("f1")
    assert status == 200
    assert payload["found"] is True
    assert payload["feature"]["id"] == "f1"
    assert payload["feature"]["title"] == "X"
    assert payload["feature"]["extra"] == "kept"


def test_get_feature_not_found_is_404(fake_db: _FakeFirestore) -> None:
    status, payload = tools._get_feature("missing")
    assert status == 404
    assert payload == {"found": False, "featureId": "missing"}


def test_get_feature_no_client_is_503(no_db: None) -> None:
    status, payload = tools._get_feature("x")
    assert status == 503
    assert payload["found"] is False
    assert payload["featureId"] == "x"


# ---------------------------------------------------------------------------
# Audit log — mcp_tool_calls
# ---------------------------------------------------------------------------
def test_audit_row_has_frontend_camelcase_fields(fake_db: _FakeFirestore) -> None:
    result = tools._run_tool("mimic_health", None, tools._health)
    assert result["status"] == "ok"

    assert len(fake_db.tool_calls) == 1
    row = fake_db.tool_calls[0]
    assert set(row.keys()) == {
        "tool",
        "client",
        "statusCode",
        "durationMs",
        "tokenId",
        "requestSummary",
        "createdAt",
    }
    assert row["tool"] == "mimic_health"
    assert row["client"] == "unknown"
    assert row["tokenId"] is None
    assert row["requestSummary"] is None
    assert row["statusCode"] == 200
    assert isinstance(row["durationMs"], int) and row["durationMs"] >= 0
    # createdAt is an ISO 8601 string parseable back to a datetime.
    from datetime import datetime

    assert isinstance(datetime.fromisoformat(row["createdAt"]), datetime)


def test_audit_records_request_summary_for_get_feature(fake_db: _FakeFirestore) -> None:
    tools._run_tool(
        "mimic_get_feature", "feature_id=abc", lambda: tools._get_feature("abc")
    )
    row = fake_db.tool_calls[0]
    assert row["tool"] == "mimic_get_feature"
    assert row["requestSummary"] == "feature_id=abc"
    assert row["statusCode"] == 404  # abc does not exist


def test_audit_records_200_for_found_feature(fake_db: _FakeFirestore) -> None:
    fake_db.features = {"abc": {"title": "Y"}}
    tools._run_tool(
        "mimic_get_feature", "feature_id=abc", lambda: tools._get_feature("abc")
    )
    assert fake_db.tool_calls[0]["statusCode"] == 200


def test_audit_records_500_when_tool_body_raises(fake_db: _FakeFirestore) -> None:
    def boom() -> tuple[int, dict[str, Any]]:
        raise RuntimeError("kaboom")

    with pytest.raises(RuntimeError, match="kaboom"):
        tools._run_tool("mimic_list_features", None, boom)

    assert fake_db.tool_calls[0]["statusCode"] == 500


def test_audit_reads_client_and_token_id_from_access_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _FakeFirestore()
    monkeypatch.setattr(tools, "get_mcp_firestore", lambda: db)
    fake_token = SimpleNamespace(
        client_id="mcp-client-x", claims={"token_id": "tok-doc-123"}
    )
    monkeypatch.setattr(tools, "_safe_access_token", lambda: fake_token)

    tools._run_tool("mimic_health", None, tools._health)

    row = db.tool_calls[0]
    assert row["client"] == "mcp-client-x"
    assert row["tokenId"] == "tok-doc-123"


def test_audit_write_failure_does_not_fail_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _FakeFirestore(add_raises=RuntimeError("firestore down"))
    monkeypatch.setattr(tools, "get_mcp_firestore", lambda: db)
    monkeypatch.setattr(tools, "_safe_access_token", lambda: None)

    # The audit write raises internally, but the tool result is returned intact.
    result = tools._run_tool("mimic_health", None, tools._health)
    assert result["status"] == "ok"
    assert db.tool_calls == []  # nothing persisted


def test_audit_skipped_without_firestore_client(no_db: None) -> None:
    # No client -> best-effort skip, no throw, tool result intact.
    result = tools._run_tool("mimic_health", None, tools._health)
    assert result["status"] == "ok"


def test_record_tool_call_never_raises_directly(no_db: None) -> None:
    # Direct call with no client must be a silent no-op.
    tools._record_tool_call(
        tool="mimic_health", status_code=200, duration_ms=1, request_summary=None
    )


# ---------------------------------------------------------------------------
# End-to-end through the registered FastMCP tool
# ---------------------------------------------------------------------------
def test_registered_health_tool_executes_and_audits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.mcp.server import mcp

    db = _FakeFirestore()
    monkeypatch.setattr(tools, "get_mcp_firestore", lambda: db)
    monkeypatch.setattr(tools, "_safe_access_token", lambda: None)

    result = asyncio.run(mcp.call_tool("mimic_health", {}))
    data = getattr(result, "data", None) or getattr(result, "structured_content", None)
    assert data is not None
    # One audit row written through the full registered path.
    assert len(db.tool_calls) == 1
    assert db.tool_calls[0]["tool"] == "mimic_health"
