"""FastMCP server instance for the tenetx-mimic backend.

A :class:`fastmcp.FastMCP` named "TenetX Mimic MCP" carrying the three read-only
``mimic_*`` tools (registered by :func:`app.mcp.tools.register_tools`) and gated
by the fail-closed :class:`app.mcp.auth.McpAccessTokenVerifier` (Firestore
``mcp_tokens`` PAT verification) on every ``/mcp`` request.

Tool registration happens HERE, right after the instance is created, so the tools
exist BEFORE ``app.mcp.lifespan.get_mcp_http_app()`` freezes the Streamable HTTP
app — a tool registered after ``http_app()`` would never be exposed.

Auth construction is side-effect free: ``McpAccessTokenVerifier()`` does not
touch Firestore at import time (the client is resolved lazily per-request), so
the mount + lifespan wiring from todo 1 stays unchanged.
"""
from __future__ import annotations

from fastmcp import FastMCP

from app.mcp.auth import McpAccessTokenVerifier

# Fail-closed Bearer PAT gate: every /mcp request must present a token whose
# sha256 hash matches an unrevoked, unexpired row in Firestore mcp_tokens.
# Construction is lazy w.r.t. Firestore (db resolved per-request), so this is
# safe at import time even when FIREBASE_REFRESH_TOKEN is unset (fail-closed).
mcp: FastMCP = FastMCP(
    name="TenetX Mimic MCP",
    instructions=(
        "Model Context Protocol server for the TenetX Mimic simulation "
        "environment. Exposes read-only tools to inspect mimic features "
        "(mimic_health, mimic_list_features, mimic_get_feature)."
    ),
    auth=McpAccessTokenVerifier(),
)

# Register the mimic_* tools on the instance immediately. Imported here rather
# than at module top to keep the import graph a straight line
# server -> tools -> firestore_client (tools never imports server back).
from app.mcp.tools import register_tools  # noqa: E402 — after mcp is defined

register_tools(mcp)

__all__ = ["mcp"]
