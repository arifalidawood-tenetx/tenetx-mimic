"""Firebase Admin init + FastAPI auth dependency — ported from
tenetx-mimic-backend/src/index.ts:42-134.

The Node original does two things in one file; this module splits them into two
independently-consumable pieces so the two downstream todos can each take only
the half they need:

  (a) :func:`init_firebase_app` — Firebase Admin SDK bootstrap with a
      refresh-token ("authorized_user") credential (index.ts:57-84). Runs once at
      startup. Idempotent, so it is a shared prerequisite for BOTH the auth
      dependency below AND todo 7's Firestore client (which imports and calls it
      to construct a ``google-cloud-firestore`` client off the same default app).

  (b) :func:`require_tenetx_user` — the FastAPI dependency equivalent of
      ``authMiddleware`` (index.ts:95-134). Applied ONLY to ``/verify-metadata``
      (todo 4). It is NEVER applied to the four ``/saml/*`` routes: during a real
      SAML login the browser/IdP POSTs to those routes and cannot carry a Firebase
      ID token, so index.ts:557/704/761/827 mount them with "NO authMiddleware" by
      design. Those routes only need init (a) for Firestore access, not this gate.

WHY a refresh-token credential (not a service-account key): creating
service-account keys on this GCP project is blocked by the org policy
``constraints/iam.disableServiceAccountKeyCreation`` (confirmed), so a cert
credential can never be populated. We reuse the same ``firebase login:ci``
refresh token used for this project's Firebase CLI deploys (Coolify env
``FIREBASE_REFRESH_TOKEN``); ``auth.verify_id_token`` works with it. The
client_id/client_secret below are firebase-tools' OWN PUBLIC OAuth client
credentials, embedded verbatim in the open-source firebase-tools ``lib/api.js`` —
documented-in-source PUBLIC values, NOT secrets (index.ts:54-59).

Error-shape parity: FastAPI's default ``HTTPException`` renders ``{"detail": ...}``.
The Node backend returns ``{"error": ...}``. To keep the wire contract identical,
this module raises a dedicated :class:`AuthError` and renders it via
:func:`auth_error_handler` (registered by :func:`register_auth`), which Starlette
serializes as compact JSON (``separators=(",", ":")``) exactly like Express
``res.json``. All three 401 bodies match index.ts:103/117-119/132 verbatim.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Optional

import firebase_admin
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials

from app.logger import log_event, logger

__all__ = [
    "FIREBASE_TOOLS_CLIENT_ID",
    "FIREBASE_TOOLS_CLIENT_SECRET",
    "FIREBASE_PROJECT_ID",
    "ALLOWED_EMAIL_DOMAIN",
    "AuthenticatedUser",
    "AuthError",
    "init_firebase_app",
    "require_tenetx_user",
    "auth_error_handler",
    "register_auth",
]

# firebase-tools' OWN PUBLIC OAuth client credentials (index.ts:57-59). Embedded
# verbatim in open-source firebase-tools `lib/api.js` — public values, NOT secrets.
FIREBASE_TOOLS_CLIENT_ID = (
    "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
)
FIREBASE_TOOLS_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"

# verify_id_token() needs to know which project's tokens to accept. A refresh-token
# credential (unlike a cert credential) has no project baked in, so it is set
# explicitly here (index.ts:78).
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


def init_firebase_app() -> Optional[firebase_admin.App]:
    """Initialize (once) the default Firebase Admin app. Port of index.ts:57-84.

    Idempotent: returns the already-initialized default app if present, so it is
    safe for both this module's startup wiring AND todo 7's Firestore client to
    call. Returns ``None`` when ``FIREBASE_REFRESH_TOKEN`` is unset — mirroring the
    Node warn-and-continue branch (index.ts:62-65), after which token verification
    has no app and every request is rejected with the invalid-token 401.

    A refresh-token credential does NO network I/O at construction; the token is
    exchanged lazily on first API use. The value is passed straight into the
    credential and is never logged.
    """
    # Idempotency: firebase_admin.get_app() raises ValueError when the default app
    # does not yet exist; any other state means it is already initialized.
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    firebase_refresh_token = os.environ.get("FIREBASE_REFRESH_TOKEN")
    if not firebase_refresh_token:
        log_event(
            logger,
            "warn",
            "FIREBASE_REFRESH_TOKEN not set. Auth middleware will reject all requests.",
        )
        return None

    try:
        credential = credentials.RefreshToken(
            {
                "type": "authorized_user",
                "client_id": FIREBASE_TOOLS_CLIENT_ID,
                "client_secret": FIREBASE_TOOLS_CLIENT_SECRET,
                "refresh_token": firebase_refresh_token,
            }
        )
        return firebase_admin.initialize_app(
            credential, {"projectId": FIREBASE_PROJECT_ID}
        )
    except Exception as error:  # noqa: BLE001 — parity with index.ts:80's catch-all
        # index.ts:81-82 logs then process.exit(1): a boot-time misconfiguration is
        # unrecoverable, so fail fast rather than serve every request as a 401.
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
