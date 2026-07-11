"""Tests for app/mimic_connections.py — ported one-to-one from
tenetx-mimic-backend/test/mimicConnections.test.ts.

Mocking strategy (mirrors the vitest original + the todo 4/5 pattern of mocking
external deps when no live credentials are available):

  * The Node test memoizes ONE Firestore client and drives ``.doc(...).get()`` off
    a single hoisted ``mockGet`` (mimicConnections.test.ts:12-22). We do the same:
    a per-test ``mock_get`` backs the whole ``collection().document().get()`` chain
    and each test sets its ``return_value`` / ``side_effect``.
  * ``firebase_admin.firestore.client`` and ``app.mimic_connections.init_firebase_app``
    are BOTH patched, so the suite is fully hermetic — no real Firebase Admin app,
    no Firestore emulator, no credentials, no network. (No live emulator/creds are
    available in this environment; ``FIREBASE_REFRESH_TOKEN`` is unset here.)
  * The module memoizes ``_db_singleton``; it is reset to ``None`` per test so each
    test's patched client factory takes effect (== the Node ``mockGet.mockReset()``).
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import Mock

import pytest

from app import mimic_connections


class _FakeSnapshot:
    """Minimal ``google.cloud.firestore`` DocumentSnapshot stand-in: the two members
    the port reads — a bool ``exists`` property and a ``to_dict()`` method."""

    def __init__(self, exists: bool, data: Optional[dict[str, Any]]) -> None:
        self.exists = exists
        self._data = data

    def to_dict(self) -> Optional[dict[str, Any]]:
        return self._data


def _make_fake_db(mock_get: Mock) -> SimpleNamespace:
    """Build a fake db whose ``collection(...).document(...).get`` IS ``mock_get`` —
    the Python analogue of the vitest ``Firestore`` factory mock
    (mimicConnections.test.ts:14-22)."""
    doc_ref = SimpleNamespace(get=mock_get)
    collection_ref = SimpleNamespace(document=Mock(return_value=doc_ref))
    return SimpleNamespace(collection=Mock(return_value=collection_ref))


@pytest.fixture
def driver(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    # Token present by default == vitest beforeEach setting a fake token
    # (mimicConnections.test.ts:35).
    monkeypatch.setenv("FIREBASE_REFRESH_TOKEN", "fake-refresh-token")
    # Reset the memoized client so this test's patched factory is used.
    monkeypatch.setattr(mimic_connections, "_db_singleton", None)
    # init_firebase_app -> no-op Mock: proves we wire it WITHOUT creating a real
    # default Firebase app (idempotent bootstrap owned by app/auth.py).
    init_mock = Mock(return_value=object())
    monkeypatch.setattr(mimic_connections, "init_firebase_app", init_mock)
    # One mock drives the whole chain (== the hoisted vitest mockGet).
    mock_get = Mock()
    fake_db = _make_fake_db(mock_get)
    client_factory = Mock(return_value=fake_db)
    monkeypatch.setattr(mimic_connections.firestore, "client", client_factory)
    return SimpleNamespace(
        init_mock=init_mock,
        client_factory=client_factory,
        mock_get=mock_get,
        fake_db=fake_db,
    )


def test_returns_all_four_fields_verbatim_on_found_doc(driver: SimpleNamespace) -> None:
    """Happy path — mimicConnections.test.ts:48-67."""
    driver.mock_get.return_value = _FakeSnapshot(
        True,
        {
            "entity_id": "https://idp.example/entity",
            "sso_url": "https://idp.example/sso",
            "slo_url": "https://idp.example/slo",
            "certificate": "-----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----",
        },
    )

    result = mimic_connections.get_mimic_idp_connection("doc123")

    assert result == {
        "entity_id": "https://idp.example/entity",
        "sso_url": "https://idp.example/sso",
        "slo_url": "https://idp.example/slo",
        "certificate": "-----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----",
    }
    # Wiring guard: the Firestore client is built off the shared default Firebase
    # app via init_firebase_app() (MUST-DO of todo 7).
    driver.init_mock.assert_called_once()
    driver.client_factory.assert_called_once()


def test_returns_none_when_doc_does_not_exist(driver: SimpleNamespace) -> None:
    """exists: false -> None — mimicConnections.test.ts:69-78."""
    driver.mock_get.return_value = _FakeSnapshot(False, None)

    assert mimic_connections.get_mimic_idp_connection("missing-doc") is None


def test_returns_none_never_raises_when_firestore_throws(driver: SimpleNamespace) -> None:
    """Firestore error -> None, never an unhandled exception —
    mimicConnections.test.ts:80-87."""
    driver.mock_get.side_effect = RuntimeError("Firestore unavailable")

    assert mimic_connections.get_mimic_idp_connection("boom") is None


def test_returns_none_when_doc_missing_entity_id(driver: SimpleNamespace) -> None:
    """Doc without entity_id -> None — mimicConnections.test.ts:89-105."""
    driver.mock_get.return_value = _FakeSnapshot(
        True,
        {
            "sso_url": "https://idp.example/sso",
            "slo_url": "https://idp.example/slo",
            "certificate": "SOME-CERT",
        },
    )

    assert mimic_connections.get_mimic_idp_connection("no-entity-id") is None


def test_coerces_missing_or_wrong_typed_fields_to_empty_strings(
    driver: SimpleNamespace,
) -> None:
    """Missing / wrong-typed sso_url, slo_url, certificate -> '' —
    mimicConnections.test.ts:107-126."""
    driver.mock_get.return_value = _FakeSnapshot(
        True,
        {
            "entity_id": "https://idp.example/entity",
            # sso_url absent
            "slo_url": 12345,  # wrong type
            # certificate absent
        },
    )

    result = mimic_connections.get_mimic_idp_connection("partial-doc")

    assert result == {
        "entity_id": "https://idp.example/entity",
        "sso_url": "",
        "slo_url": "",
        "certificate": "",
    }


def test_returns_none_without_throwing_when_token_unset(
    driver: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FIREBASE_REFRESH_TOKEN unset -> None, short-circuits before Firestore —
    mimicConnections.test.ts:128-137."""
    monkeypatch.delenv("FIREBASE_REFRESH_TOKEN", raising=False)

    assert mimic_connections.get_mimic_idp_connection("any-doc") is None
    # Must short-circuit BEFORE ever building or touching Firestore — and before
    # init_firebase_app (the token re-check is independent of the memoized client).
    driver.client_factory.assert_not_called()
    driver.mock_get.assert_not_called()
    driver.init_mock.assert_not_called()


def test_warn_paths_route_through_structured_logger(
    driver: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Python analogue of the vitest ``console.warn`` regression guards
    (mimicConnections.test.ts:75-77/84-86/102-104/134-136): every null path must
    route through the structured ``log_event`` at ``warn`` level, never a raw
    ``print``/``console.warn``."""
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        mimic_connections,
        "log_event",
        lambda instance, level, msg, payload=None: calls.append((level, msg)),
    )
    driver.mock_get.return_value = _FakeSnapshot(False, None)

    assert mimic_connections.get_mimic_idp_connection("missing-doc") is None
    assert len(calls) == 1
    assert calls[0][0] == "warn"
