"""Mount + lifespan tests for the FastMCP Streamable HTTP app (working-mcp-pat todo 1).

Every test drives the app through ``with TestClient(app) as client:`` — the
context-manager form runs the ASGI lifespan (test_verify_metadata uses this),
so the MCP StreamableHTTP session manager is actually started. A bare
``TestClient(app)`` skips lifespan (the SAML suite's form) and would make the
transport probe fail on a dead session manager rather than on auth — do NOT copy
that pattern here.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastmcp")

from fastapi.testclient import TestClient

from app.main import app, mcp_http_app


def test_http_app_mounted_at_single_mcp_path() -> None:
    routes = [getattr(r, "path", "") for r in app.routes]
    assert "/mcp" in routes
    assert "/mcp/mcp" not in routes


def test_mcp_app_serves_at_mount_root_not_double_path() -> None:
    mcp_routes = [getattr(r, "path", "") for r in mcp_http_app.routes]
    assert "/" in mcp_routes
    assert "/mcp" not in mcp_routes


def test_health_still_200_with_lifespan_active() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_mcp_probe_does_not_500_on_dead_session_manager() -> None:
    """Lifespan/session-manager smoke: missing Bearer yields 401 (auth gate),
    never a dead-session-manager 500. Auth-gate success paths live in
    ``test_mcp_auth_gate.py``.
    """
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "todo1-probe", "version": "0.0.0"},
        },
    }
    with TestClient(app) as client:
        response = client.post(
            "/mcp/",
            json=initialize,
            headers={"Accept": "application/json, text/event-stream"},
        )
    # 401 is expected without Authorization once the PAT verifier is wired.
    # A missing lifespan would 500 with "Task group is not initialized" instead.
    assert response.status_code != 500
    assert "Task group is not initialized" not in response.text
    assert response.status_code == 401
