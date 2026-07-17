"""Tests for app/mcp/firestore_client.py.

Mocking strategy mirrors app/test/test_mimic_connections.py: the keyless credential
factory (``firestore_client.get_google_credentials``) and the RAW
``google.cloud.firestore.Client`` constructor (``firestore_client.firestore.Client``)
are patched, so the suite is fully hermetic — no Keycloak, no GCP STS, no real
Firestore client, no network. The MCP-owned ``_mcp_db_singleton`` is reset to
``None`` per test so each test's patched factory takes effect.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.mcp import firestore_client


@pytest.fixture
def driver(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    # Credentials configured by default; individual tests force None to exercise
    # the unconfigured (fail-closed) path.
    fake_creds = SimpleNamespace(name="fake-wif-credentials")
    creds_factory = Mock(return_value=fake_creds)
    monkeypatch.setattr(firestore_client, "get_google_credentials", creds_factory)
    # Reset the MCP-owned memoized client so this test's patched factory is used.
    monkeypatch.setattr(firestore_client, "_mcp_db_singleton", None)
    fake_db = SimpleNamespace(name="fake-mcp-db")
    client_factory = Mock(return_value=fake_db)
    monkeypatch.setattr(firestore_client.firestore, "Client", client_factory)
    return SimpleNamespace(
        creds_factory=creds_factory,
        fake_creds=fake_creds,
        client_factory=client_factory,
        fake_db=fake_db,
    )


def test_returns_none_without_throwing_when_credentials_unconfigured(
    driver: SimpleNamespace,
) -> None:
    """Factory returns None -> None, short-circuits before client construction."""
    driver.creds_factory.return_value = None

    assert firestore_client.get_mcp_firestore() is None
    # Must short-circuit BEFORE ever building the client.
    driver.client_factory.assert_not_called()


def test_constructs_client_with_project_and_wif_credentials(
    driver: SimpleNamespace,
) -> None:
    """With credentials present -> raw firestore.Client built with project + creds."""
    result = firestore_client.get_mcp_firestore()

    assert result is driver.fake_db
    driver.client_factory.assert_called_once()
    _, kwargs = driver.client_factory.call_args
    assert kwargs["project"] == "tenetx-qa-scores"
    # Credential is the factory-produced WIF credential, NOT firebase_admin.
    assert kwargs["credentials"] is driver.fake_creds


def test_client_is_memoized_across_calls(driver: SimpleNamespace) -> None:
    """The MCP-owned singleton is constructed exactly once across repeated calls."""
    first = firestore_client.get_mcp_firestore()
    second = firestore_client.get_mcp_firestore()

    assert first is second
    driver.client_factory.assert_called_once()


def test_returns_none_never_raises_when_construction_fails(
    driver: SimpleNamespace,
) -> None:
    """Any error during client construction -> None, never an unhandled exception."""
    driver.client_factory.side_effect = RuntimeError("client build blew up")

    assert firestore_client.get_mcp_firestore() is None


def test_uses_own_singleton_not_mimic_connections(
    driver: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Metis N3: MCP client is independent of mimic_connections._db_singleton."""
    from app import mimic_connections

    sentinel = SimpleNamespace(name="mimic-db-should-not-be-returned")
    monkeypatch.setattr(mimic_connections, "_db_singleton", sentinel)

    result = firestore_client.get_mcp_firestore()

    assert result is driver.fake_db
    assert result is not sentinel
