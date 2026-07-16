"""MCP Streamable HTTP ASGI app factory for the tenetx-mimic backend.

``get_mcp_http_app()`` builds the FastMCP Streamable HTTP ASGI app that
``app.main`` mounts at ``/mcp``. Two load-bearing details, both learned from the
xauusd reference (``adapters/api/lifespan.py`` + ``app.py``):

1. **path="/"** — FastMCP's ``http_app`` defaults the internal route to
   ``/mcp``. Mounting that at ``/mcp`` yields the double path ``/mcp/mcp``. We
   pass ``path="/"`` so the app serves at its mount root and the single public
   URL is exactly ``{base}/mcp``. (The xauusd reference OMITS this and ships the
   ``/mcp/mcp`` bug — we deviate here on purpose.)
2. The returned app carries a **``.lifespan``** that starts the StreamableHTTP
   session manager. ``app.main`` MUST thread that into the parent FastAPI
   lifespan; mounting alone leaves the session manager uninitialized and every
   MCP call 500s with "Task group is not initialized" while ``/health`` still
   looks fine.
"""
from __future__ import annotations

from typing import Any

from app.mcp.server import mcp

# Module-level singleton. Type is FastMCP's StarletteWithLifespan; annotated Any
# to avoid importing a private FastMCP symbol just for the hint.
_mcp_http_app: Any = None


def get_mcp_http_app() -> Any:
    """Return the process-wide MCP Streamable HTTP ASGI app (built once).

    Returns:
        The FastMCP Streamable HTTP ASGI app, whose ``.lifespan`` MUST be run by
        the parent FastAPI app for the session manager to start.
    """
    global _mcp_http_app
    if _mcp_http_app is not None:
        return _mcp_http_app

    # transport="http" selects the modern Streamable HTTP transport (no legacy
    # SSE app). path="/" is REQUIRED so mounting at "/mcp" does not become
    # "/mcp/mcp" — see module docstring.
    _mcp_http_app = mcp.http_app(transport="http", path="/")
    return _mcp_http_app


__all__ = ["get_mcp_http_app"]
