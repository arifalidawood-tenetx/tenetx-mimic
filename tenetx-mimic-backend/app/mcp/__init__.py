"""MCP (Model Context Protocol) package for the tenetx-mimic backend.

Owns the FastMCP server instance (:mod:`app.mcp.server`) and the Streamable
HTTP ASGI app factory (:mod:`app.mcp.lifespan`) mounted at ``/mcp`` by
``app.main``. Auth (Firestore PAT verification) and tools land in later todos;
this package's todo-1 job is only to make the mount start cleanly.
"""
