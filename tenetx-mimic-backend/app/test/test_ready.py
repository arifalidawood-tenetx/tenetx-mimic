"""Tests for GET /ready and GET /health endpoints.

/ready is a diagnostic endpoint (always 200) that reports credential configuration.
/health is a liveness check (always 200, unchanged).

Mocking strategy: monkeypatch get_mcp_firestore and get_google_credentials to
control the credential state without network I/O.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    """FastAPI test client."""
    return TestClient(app)


@pytest.fixture
def mock_credentials(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Fixture to control credential state via monkeypatch.
    
    Patches get_google_credentials and get_mcp_firestore in the main module
    where they are imported, not in their source modules.
    """
    from app import main

    fake_creds = SimpleNamespace(name="fake-wif-credentials")
    creds_factory = Mock(return_value=fake_creds)
    monkeypatch.setattr(main, "get_google_credentials", creds_factory)

    fake_db = SimpleNamespace(name="fake-mcp-db")
    firestore_factory = Mock(return_value=fake_db)
    monkeypatch.setattr(main, "get_mcp_firestore", firestore_factory)

    return SimpleNamespace(
        creds_factory=creds_factory,
        fake_creds=fake_creds,
        firestore_factory=firestore_factory,
        fake_db=fake_db,
    )


def test_health_always_200_with_status_ok(client: TestClient) -> None:
    """GET /health always returns 200 with {"status": "ok"}."""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_always_200(client: TestClient, mock_credentials: SimpleNamespace) -> None:
    """GET /ready always returns 200, never 503."""
    response = client.get("/ready")

    assert response.status_code == 200


def test_ready_with_firestore_configured(
    client: TestClient, mock_credentials: SimpleNamespace
) -> None:
    """GET /ready with Firestore configured returns firestoreConfigured=true."""
    response = client.get("/ready")
    body = response.json()

    assert body["status"] == "ok"
    assert body["firestoreConfigured"] is True
    assert body["credentialMode"] == "wif"


def test_ready_without_firestore_configured(
    client: TestClient, mock_credentials: SimpleNamespace
) -> None:
    """GET /ready without Firestore configured returns status=degraded."""
    mock_credentials.firestore_factory.return_value = None

    response = client.get("/ready")
    body = response.json()

    assert body["status"] == "degraded"
    assert body["firestoreConfigured"] is False
    assert body["credentialMode"] == "wif"


def test_ready_without_credentials_factory(
    client: TestClient, mock_credentials: SimpleNamespace
) -> None:
    """GET /ready when credentials factory returns None."""
    mock_credentials.creds_factory.return_value = None
    mock_credentials.firestore_factory.return_value = None

    response = client.get("/ready")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "degraded"
    assert body["firestoreConfigured"] is False
    assert "credentialMode" not in body


def test_ready_firestore_client_construction_failure(
    client: TestClient, mock_credentials: SimpleNamespace
) -> None:
    """GET /ready when Firestore client construction fails (returns None)."""
    mock_credentials.firestore_factory.return_value = None

    response = client.get("/ready")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "degraded"
    assert body["firestoreConfigured"] is False
    assert body["credentialMode"] == "wif"


def test_health_unchanged_when_ready_called(
    client: TestClient, mock_credentials: SimpleNamespace
) -> None:
    """GET /health is unaffected by GET /ready calls."""
    # Call /ready first.
    ready_response = client.get("/ready")
    assert ready_response.status_code == 200

    # /health must still return exactly {"status": "ok"}.
    health_response = client.get("/health")
    assert health_response.status_code == 200
    assert health_response.json() == {"status": "ok"}
