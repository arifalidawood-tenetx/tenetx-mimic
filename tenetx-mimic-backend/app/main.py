"""FastAPI application entrypoint for the tenetx-mimic Python backend.

Skeleton parity with tenetx-mimic-backend/src/index.ts:
- FastAPI app instance replaces ``express()`` (index.ts:17).
- ``CORSMiddleware`` allowlists only the deployed mimic Hosting origin, porting
  the ``cors`` middleware at index.ts:33-40. FastAPI parses JSON/form bodies
  per-route, so there is no separate ``express.json()`` / ``express.urlencoded()``
  body parser to port (index.ts:28-31).
- ``GET /health`` -> 200 ``{"status": "ok"}`` at parity with index.ts:137-139.

``/health`` is defined inline; ``/verify-metadata`` is mounted from
``app.routes.verify_metadata`` (todo 4, gated by the Firebase auth dependency).
The ``/saml/*`` routes are owned by later migration todos.

Run modes:
- ``uvicorn app.main:app --host <resolved> --port 3000`` (import the ``app`` object).
- ``python -m app.main`` (Docker CMD) -> ``main()`` binds to
  :func:`app.host_resolution.resolve_listen_host`, so the same HOST logic as the
  Node backend decides the bind address.
"""
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import init_firebase_app, register_auth
from app.gcp_credentials import get_google_credentials
from app.host_resolution import resolve_listen_host
from app.logger import RequestIdLoggingMiddleware
from app.mcp.firestore_client import get_mcp_firestore
from app.mcp.lifespan import get_mcp_http_app
from app.mcp_path_normalize import McpPathNormalizeMiddleware
from app.routes.saml_acs import router as saml_acs_router
from app.routes.saml_login import router as saml_login_router
from app.routes.saml_logout import router as saml_logout_router
from app.routes.verify_metadata import router as verify_metadata_router

# Build the MCP Streamable HTTP app BEFORE the FastAPI app so its lifespan can be
# threaded into the parent lifespan below. mount() alone does NOT start the
# StreamableHTTP session manager — without the parent running mcp_http_app.lifespan,
# every /mcp call 500s "Task group is not initialized" while /health stays 200.
mcp_http_app = get_mcp_http_app()


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Parent FastAPI lifespan that drives the MCP session manager.

    This backend has no startup work of its own (``init_firebase_app()`` runs at
    import time, below), so the sole job here is to run ``mcp_http_app.lifespan``
    — the FastMCP-documented requirement that boots the StreamableHTTP session
    manager. Skip it and the /mcp mount answers every request with
    "Task group is not initialized".
    """
    async with mcp_http_app.lifespan(app):
        yield


app = FastAPI(title="tenetx-mimic-backend", version="1.0.0", lifespan=_lifespan)

# Mount the FastMCP Streamable HTTP app at /mcp. get_mcp_http_app() built it with
# path="/", so the public URL is exactly {base}/mcp — never /mcp/mcp. Mounted
# before the routers below; SAML/verify-metadata/health routes are untouched.
#
# Starlette's Mount only matches "<prefix>/<rest>" internally, so a bare
# POST {base}/mcp (no trailing slash) would normally 307 to {base}/mcp/ first.
# However, McpPathNormalizeMiddleware (added below as the outermost middleware)
# rewrites bare /mcp → /mcp/ in-process for all HTTP methods, so auth-bearing
# MCP clients never see the 307 and Authorization stays intact. Disabling
# redirect_slashes would break the mount entirely (307 -> 404), so the in-process
# rewrite is the correct fix.
app.mount("/mcp", mcp_http_app)

# CORS — allowlist only the deployed mimic Hosting origin (index.ts:33-40).
allowed_origin = os.environ.get("ALLOWED_ORIGIN", "https://tenetx-mimic.web.app")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[allowed_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request-id + request logging. MUST stay AFTER CORSMiddleware: Starlette makes
# the last-added middleware outermost, so this order is what wraps every request
# incl. CORS-rejected (index.ts:24-25 mounts createHttpLogger() first).
app.add_middleware(RequestIdLoggingMiddleware)

# MCP path normalization: rewrite bare /mcp → /mcp/ in-process for all HTTP methods.
# Added AFTER RequestIdLoggingMiddleware so it is outermost and rewrites before Mount.
app.add_middleware(McpPathNormalizeMiddleware)

# Firebase Admin init (index.ts:57-84): idempotent, shared by todo 4's auth
# dependency AND todo 7's Firestore client. Handler renders AuthError as the Node
# {"error": ...} 401 body; it fires only for AuthError. The /verify-metadata route
# (todo 4) consumes require_tenetx_user; the four /saml/* routes are never gated by
# it (index.ts:557/704/761/827 mount them "NO authMiddleware" by design).
init_firebase_app()
register_auth(app)

# POST /verify-metadata (todo 4) — the only route carrying require_tenetx_user.
app.include_router(verify_metadata_router)

# GET /saml/login (todo 8) — UNAUTHENTICATED in-process SP-initiated login kickoff
# (index.ts:704-706 "NO authMiddleware"). No Depends(require_tenetx_user).
app.include_router(saml_login_router)

# POST /saml/acs (todo 9) — UNAUTHENTICATED in-process SAML ACS validation. Keycloak
# POSTs a signed SAMLResponse here mid-flow with no Firebase token, so — like
# /saml/login — it is never gated (index.ts:557-559 "NO authMiddleware"). No
# Depends(require_tenetx_user).
app.include_router(saml_acs_router)

# GET /saml/logout + GET /saml/sls (todo 10) — UNAUTHENTICATED in-process SAML SLO
# via OneLogin_Saml2_Auth.logout()/process_slo(). The browser hits /saml/logout
# mid-flow and the IdP redirects to /saml/sls, neither carrying a Firebase token, so —
# like /saml/login and /saml/acs — they are never gated (index.ts:761/827 "NO
# authMiddleware"). No Depends(require_tenetx_user).
app.include_router(saml_logout_router)


@app.get("/")
def root() -> dict[str, str]:
    """Root route (no auth) - basic service identification so ``GET /`` returns
    200 instead of a bare 404 (no parity target: the Node backend never had one)."""
    return {"service": app.title, "version": app.version, "status": "ok"}


@app.get("/health")
def health() -> dict[str, str]:
    """Health check (no auth), parity with index.ts:137-139: 200 ``{"status": "ok"}``."""
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, bool | str]:
    """Readiness check (no auth) — always 200, diagnostic of credential configuration.

    Returns:
        - ``status``: "ok" if Firestore configured, "degraded" if not
        - ``firestoreConfigured``: True if Firestore client is available (WIF/Keycloak configured)
        - ``credentialMode``: "wif" if using Workload Identity Federation (optional, cheap check)

    Construction-only check — no live Firestore query. Coolify liveness stays on /health.
    """
    firestore_available = get_mcp_firestore() is not None
    creds = get_google_credentials()
    credential_mode = "wif" if creds is not None else None

    result: dict[str, bool | str] = {
        "status": "ok" if firestore_available else "degraded",
        "firestoreConfigured": firestore_available,
    }
    if credential_mode is not None:
        result["credentialMode"] = credential_mode

    return result


def main() -> None:
    """Start uvicorn bound to ``resolve_listen_host()`` — parity with the Node host binding.

    Production uses Dockerfile CMD with proxy_headers flags; this main() adds them for
    local/python -m parity. Coolify Traefik is the sole ingress; port 3000 is not
    host-published; forwarded_allow_ips=* trusts X-Forwarded-* only from docker network peers.
    """
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=resolve_listen_host(),
        port=int(os.environ.get("PORT", "3000")),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
