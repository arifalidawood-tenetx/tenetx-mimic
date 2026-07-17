"""Firebase Admin init + FastAPI auth dependency — ported from
tenetx-mimic-backend/src/index.ts:42-134.

The Node original does two things in one file; this module splits them into two
independently-consumable pieces so the two downstream todos can each take only
the half they need:

  (a) :func:`init_firebase_app` — Firebase Admin SDK bootstrap with keyless
      Keycloak-OIDC + GCP Workload Identity Federation credentials (via
      :func:`app.gcp_credentials.get_google_credentials`). Runs once at startup.
      Idempotent, so it is a shared prerequisite for BOTH the auth dependency below
      AND todo 7's Firestore client (which imports and calls it to construct a
      ``google-cloud-firestore`` client off the same default app).

  (b) :func:`require_tenetx_user` — the FastAPI dependency equivalent of
      ``authMiddleware`` (index.ts:95-134). Applied ONLY to ``/verify-metadata``
      (todo 4). It is NEVER applied to the four ``/saml/*`` routes: during a real
      SAML login the browser/IdP POSTs to those routes and cannot carry a Firebase
      ID token, so index.ts:557/704/761/827 mount them with "NO authMiddleware" by
      design. Those routes only need init (a) for Firestore access, not this gate.

WHY keyless WIF (not a service-account key, not a refresh token): creating
service-account keys on this GCP project is blocked by the org policy
``constraints/iam.disableServiceAccountKeyCreation`` (confirmed), and long-lived
refresh tokens are likewise disallowed. Instead we federate the existing Keycloak
OIDC provider into GCP: Keycloak ``client_credentials`` → Google STS exchange →
short-lived impersonated credentials. That single credential — produced by
:func:`app.gcp_credentials.get_google_credentials` and adapted to firebase-admin
via :class:`_WifAdminCredential` — backs both ``auth.verify_id_token`` here and the
raw Firestore clients. No key file or refresh token is ever read or stored.

Error-shape parity: FastAPI's default ``HTTPException`` renders ``{"detail": ...}``.
The Node backend returns ``{"error": ...}``. To keep the wire contract identical,
this module raises a dedicated :class:`AuthError` and renders it via
:func:`auth_error_handler` (registered by :func:`register_auth`), which Starlette
serializes as compact JSON (``separators=(",", ":")``) exactly like Express
``res.json``. All three 401 bodies match index.ts:103/117-119/132 verbatim.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any, Optional

import firebase_admin
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

from app.gcp_credentials import get_google_credentials
from app.logger import log_event, logger

__all__ = [
    "FIREBASE_PROJECT_ID",
    "ALLOWED_EMAIL_DOMAIN",
    "AuthenticatedUser",
    "AuthError",
    "init_firebase_app",
    "require_tenetx_user",
    "auth_error_handler",
    "register_auth",
]

# verify_id_token() needs to know which project's tokens to accept. The federated
# WIF credential has no project baked in, so it is set explicitly here (index.ts:78).
FIREBASE_PROJECT_ID = "tenetx-qa-scores"

# Email allowlist gate (index.ts:116). Not env-configurable — the Node backend
# hardcodes it and the plan forbids changing the domain or the verified gate.
ALLOWED_EMAIL_DOMAIN = "@tenetx.ai"


@dataclass(frozen=True)
class AuthenticatedUser:
    """The verified caller — parity with ``req.user`` (index.ts:87-92, 123-127)."""

    uid: str
    email: str
    email_verified: bool


class AuthError(Exception):
    """Auth rejection carrying the exact Node status + ``{"error": ...}`` body.

    Raised by :func:`require_tenetx_user`; rendered by :func:`auth_error_handler`
    so the response shape matches the Node backend rather than FastAPI's default
    ``{"detail": ...}``.
    """

    def __init__(self, status_code: int, payload: dict[str, str]) -> None:
        self.status_code = status_code
        self.payload = payload
        super().__init__(payload.get("error", "authentication error"))


class _WifAdminCredential(credentials.Base):
    """Adapt a ``google.auth`` Credentials (keyless Keycloak-OIDC + GCP WIF, from
    :func:`app.gcp_credentials.get_google_credentials`) to the firebase-admin
    ``credentials.Base`` interface.

    firebase-admin drives auth through ``get_credential()`` (returning a
    ``google.auth.credentials.Credentials``) and the inherited ``get_access_token()``
    (which refreshes it) — exactly what the underlying identity_pool credential
    provides. No key file, no refresh token; the token is minted lazily on first use.
    """

    def __init__(self, google_credentials: Any) -> None:
        self._google_credentials = google_credentials

    def get_credential(self) -> Any:
        return self._google_credentials


def init_firebase_app() -> Optional[firebase_admin.App]:
    """Initialize (once) the default Firebase Admin app with keyless WIF credentials.

    Idempotent: returns the already-initialized default app if present, so it is
    safe for both this module's startup wiring AND todo 7's Firestore client to
    call.

    Fail modes (parity with the prior refresh-token posture):
      * Keycloak/WIF credentials unconfigured (:func:`get_google_credentials`
        returns ``None``) → ``warn`` and ``return None`` (no exit); token
        verification then has no app and every request is rejected with the
        invalid-token 401.
      * A hard exception during ``initialize_app`` AFTER credentials resolved → a
        boot-time misconfiguration that is unrecoverable, so ``sys.exit(1)`` rather
        than serve every request as a 401 (index.ts:81-82 parity).

    The WIF credential does NO network I/O at construction; the Keycloak/STS
    exchange happens lazily on first API use. No secret or token is ever logged.
    """
    # Idempotency: firebase_admin.get_app() raises ValueError when the default app
    # does not yet exist; any other state means it is already initialized.
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    google_credentials = get_google_credentials()
    if google_credentials is None:
        log_event(
            logger,
            "warn",
            "WIF/Keycloak credentials not configured. Auth middleware will reject all requests.",
        )
        return None

    try:
        credential = _WifAdminCredential(google_credentials)
        return firebase_admin.initialize_app(
            credential, {"projectId": FIREBASE_PROJECT_ID}
        )
    except Exception as error:  # noqa: BLE001 — parity with index.ts:80's catch-all
        # A boot-time misconfiguration is unrecoverable, so fail fast rather than
        # serve every request as a 401.
        log_event(
            logger, "error", "Failed to initialize Firebase Admin SDK", {"err": str(error)}
        )
        sys.exit(1)


async def require_tenetx_user(request: Request) -> AuthenticatedUser:
    """FastAPI dependency equivalent of ``authMiddleware`` (index.ts:95-134).

    Apply ONLY to ``/verify-metadata`` (todo 4), e.g.::

        from app.auth import require_tenetx_user, AuthenticatedUser

        @router.post("/verify-metadata")
        async def verify_metadata(
            user: AuthenticatedUser = Depends(require_tenetx_user),
        ): ...

    Returns the verified :class:`AuthenticatedUser` on success (the dependency
    return value replaces Node's ``req.user`` + ``next()``); raises
    :class:`AuthError` with the exact Node 401 body on every rejection.
    """
    auth_header = request.headers.get("authorization")

    # index.ts:102-105 — missing header or non-"Bearer " prefix.
    if not auth_header or not auth_header.startswith("Bearer "):
        raise AuthError(401, {"error": "Missing or invalid Authorization header"})

    id_token = auth_header[len("Bearer ") :]  # strip "Bearer " (index.ts:107)

    try:
        decoded_token = firebase_auth.verify_id_token(id_token)
    except Exception as error:  # noqa: BLE001 — parity with index.ts:130's catch-all
        # Covers a bad/expired token AND the no-app-initialized case (get_app raises
        # ValueError inside verify_id_token), exactly like Node's getAuth() throwing.
        log_event(logger, "error", "Token verification failed", {"err": str(error)})
        raise AuthError(401, {"error": "Invalid or expired token"})

    # index.ts:113-114 — JS `|| ''` / `|| false` falsy coalescing.
    email = decoded_token.get("email") or ""
    email_verified = decoded_token.get("email_verified") or False

    # index.ts:116-121 — domain + verified gate. Both must hold.
    if not email.endswith(ALLOWED_EMAIL_DOMAIN) or not email_verified:
        raise AuthError(
            401, {"error": "Unauthorized: email must be @tenetx.ai and verified"}
        )

    return AuthenticatedUser(
        uid=decoded_token.get("uid"),
        email=email,
        email_verified=bool(email_verified),
    )


async def auth_error_handler(request: Request, exc: AuthError) -> JSONResponse:
    """Render :class:`AuthError` as the Node-shaped ``{"error": ...}`` JSON body.

    Starlette's ``JSONResponse`` serializes with ``separators=(",", ":")``, so the
    body is byte-identical to Express ``res.status(...).json({error: ...})``.
    """
    return JSONResponse(status_code=exc.status_code, content=exc.payload)


def register_auth(app: FastAPI) -> None:
    """Register the :class:`AuthError` handler on ``app``.

    Call once at wiring time (``app/main.py``). The handler fires ONLY for
    :class:`AuthError`, so it never alters any other route's error shape — routes
    that raise a normal ``HTTPException`` still get FastAPI's ``{"detail": ...}``.
    """
    app.add_exception_handler(AuthError, auth_error_handler)
