"""Pure-ASGI middleware for normalizing bare /mcp path to /mcp/.

MCP clients connecting to bare POST /mcp (no trailing slash) receive a 307
redirect to /mcp/ from Starlette's Mount. The 307 preserves method and body per
HTTP spec, but some MCP clients (e.g., httpx with certain configurations) may
drop the Authorization header on the redirect, causing a 401 on the second
request.

This middleware rewrites the path in-process: bare /mcp → /mcp/ for ALL HTTP
methods (POST, GET, DELETE, etc.), so the request never sees a 307 and auth
stays intact.

Pattern: pure-ASGI class matching RequestIdLoggingMiddleware (logger.py:316-378).
Deliberately depends on NOTHING but the stdlib, so importing this module never
requires FastAPI/Starlette.

Mount as the OUTERMOST middleware (added AFTER RequestIdLoggingMiddleware) so
the path is normalized before Mount matching::

    from app.mcp_path_normalize import McpPathNormalizeMiddleware
    app.add_middleware(CORSMiddleware, ...)
    app.add_middleware(RequestIdLoggingMiddleware)
    app.add_middleware(McpPathNormalizeMiddleware)  # outermost
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

# ASGI type hints
Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class McpPathNormalizeMiddleware:
    """Rewrite bare /mcp path to /mcp/ for all HTTP methods."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        # Exact match: bare /mcp (no trailing slash, no query string in path)
        if scope.get("path") == "/mcp":
            # Copy scope to a mutable dict before mutation
            scope = dict(scope)
            scope["path"] = "/mcp/"

            # If raw_path present (bytes), rewrite it too
            # raw_path is the path only, without query string
            if "raw_path" in scope and scope["raw_path"] == b"/mcp":
                scope["raw_path"] = b"/mcp/"

        await self.app(scope, receive, send)


__all__ = ["McpPathNormalizeMiddleware"]
