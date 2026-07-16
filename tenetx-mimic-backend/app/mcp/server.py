"""FastMCP server instance for the tenetx-mimic backend.

Skeleton for working-mcp-pat todo 1: a bare :class:`fastmcp.FastMCP` named
"TenetX Mimic MCP" with **no auth gate yet**. The fail-closed
``McpAccessTokenVerifier`` (Firestore ``mcp_tokens`` PAT verification) is wired
into ``auth=`` by todo 3; the ``mimic_*`` tools register in todo 4. Until then
this server starts, exposes the Streamable HTTP transport, and answers the MCP
protocol handshake — which is all todo 1 needs to prove the mount + lifespan
are correct.
"""
from __future__ import annotations

from fastmcp import FastMCP

# auth=None (default): NO PAT gate yet. Todo 3 replaces this with
# auth=McpAccessTokenVerifier() so every /mcp request is fail-closed behind a
# Bearer PAT. Deliberately left open here so the todo-1 transport probe can
# reach the session manager (a 401 gate would mask a dead session manager).
mcp: FastMCP = FastMCP(
    name="TenetX Mimic MCP",
    instructions=(
        "Model Context Protocol server for the TenetX Mimic simulation "
        "environment. Tools for mimic feature inspection are added in a later "
        "iteration; this skeleton exposes only the protocol handshake."
    ),
)

__all__ = ["mcp"]
