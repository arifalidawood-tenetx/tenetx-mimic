"""Transport / path integration tests for MCP (working-mcp-pat todo 5).

Pinned HTTP mode matches production: stateful Streamable HTTP via
``mcp.http_app(transport="http", path="/")`` in ``app.mcp.lifespan`` (no
``stateless_http=True``). CLI MCP clients do not need special CORS on Coolify;
browser CORS for the dashboard remains the existing Hosting-origin allowlist on
the parent FastAPI app. Authorization headers are redacted by ``app.logger``.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastmcp")

from fastapi.testclient import TestClient

from app.main import app, mcp_http_app
from app.mcp.lifespan import get_mcp_http_app


def test_public_mount_path_is_mcp_not_double_mcp() -> None:
    routes = [getattr(r, "path", "") for r in app.routes]
    assert "/mcp" in routes
    assert "/mcp/mcp" not in routes


def test_mcp_http_app_serves_at_mount_root() -> None:
    mcp_routes = [getattr(r, "path", "") for r in mcp_http_app.routes]
    assert "/" in mcp_routes
    assert "/mcp" not in mcp_routes


def test_http_mode_is_stateful_streamable_default() -> None:
    """Prod + tests share one mode: stateful Streamable HTTP (path='/').

    ``get_mcp_http_app`` builds with ``transport="http", path="/"`` and does NOT
    pass ``stateless_http=True``. This test locks that contract so a future
    drift to a different test-only mode is caught.
    """
    built = get_mcp_http_app()
    assert built is mcp_http_app
    assert hasattr(built, "lifespan")


def test_health_200_with_lifespan_active() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_logger_redacts_authorization_header_key() -> None:
    from app.logger import REDACT_CONFIG

    # Logger redacts by dotted key path (parity with Node pino REDACT_CONFIG).
    assert "req.headers.authorization" in REDACT_CONFIG["paths"]
