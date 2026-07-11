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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import init_firebase_app, register_auth
from app.host_resolution import resolve_listen_host
from app.logger import RequestIdLoggingMiddleware
from app.routes.saml_acs import router as saml_acs_router
from app.routes.saml_login import router as saml_login_router
from app.routes.saml_logout import router as saml_logout_router
from app.routes.verify_metadata import router as verify_metadata_router

app = FastAPI(title="tenetx-mimic-backend", version="1.0.0")

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


@app.get("/health")
def health() -> dict[str, str]:
    """Health check (no auth), parity with index.ts:137-139: 200 ``{"status": "ok"}``."""
    return {"status": "ok"}


def main() -> None:
    """Start uvicorn bound to ``resolve_listen_host()`` — parity with the Node host binding."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=resolve_listen_host(),
        port=int(os.environ.get("PORT", "3000")),
    )


if __name__ == "__main__":
    main()
