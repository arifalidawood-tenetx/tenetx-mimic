"""Firestore client for the MCP subsystem — same raw-``google-cloud-firestore``
construction as ``app/mimic_connections.py``, with its OWN module-level singleton.

The MCP PAT verifier (todo 3) and the ``mimic_*`` tools (todo 4) read Firestore
(``mcp_tokens``, ``mimic_features``, ``mcp_tool_calls``) with the SAME
``authorized_user`` refresh-token credential the SAML proxy already uses. This
module hands them a client built exactly like ``mimic_connections._get_firestore``:

  * a :class:`google.oauth2.credentials.Credentials` from ``FIREBASE_REFRESH_TOKEN``
    plus firebase-tools' public ``client_id``/``client_secret`` (imported from
    ``app/auth.py`` — the single source of those constants), then
  * a RAW ``google.cloud.firestore.Client(project=..., credentials=...)``.

It deliberately does NOT use ``firebase_admin.firestore.client()``: that wrapper
broadens the credential's OAuth scopes in a way an ``authorized_user`` refresh
token cannot satisfy, producing a ~300s retry storm / ``restricted_client`` 503
(documented at length in ``mimic_connections.py``). A raw client with an explicit
``Credentials`` bypasses that broadening — the only construction proven to work
with this credential.

WHY a private singleton here instead of importing ``mimic_connections._db_singleton``
(Metis N3): ``_db_singleton`` is a private, test-reset implementation detail of the
SAML per-tester lookup. Reaching into another module's private memo couples the two
subsystems' lifecycles (a test that resets one silently disturbs the other) and
imports a name the owning module never exported. The MCP subsystem owns its own
:data:`_mcp_db_singleton`; the two clients are identical in construction but
independent in lifetime.

NEVER throws. An unset/empty ``FIREBASE_REFRESH_TOKEN`` resolves to ``None`` (after
a structured ``warn``) so the verifier can fail-closed cleanly rather than 500. The
env var is re-checked on EVERY call, independent of the memoized client, so an unset
token always degrades to ``None`` even after the singleton was built by an earlier
call with the token present (parity with ``mimic_connections.get_mimic_idp_connection``).
"""
from __future__ import annotations

import os
from typing import Any, Optional

from google.cloud import firestore
from google.oauth2.credentials import Credentials

from app.auth import (
    FIREBASE_PROJECT_ID,
    FIREBASE_TOOLS_CLIENT_ID,
    FIREBASE_TOOLS_CLIENT_SECRET,
)
from app.logger import log_event, logger

__all__ = ["get_mcp_firestore"]

# MCP-owned memoized singleton, built on the FIRST successful construction only. A
# failed construction leaves this ``None`` so the next call retries. Independent of
# ``mimic_connections._db_singleton`` by design (see module docstring, Metis N3).
_mcp_db_singleton: Optional[Any] = None


def get_mcp_firestore() -> Optional[Any]:
    """Return a memoized RAW ``google.cloud.firestore.Client`` for the MCP subsystem,
    or ``None`` when ``FIREBASE_REFRESH_TOKEN`` is unset.

    NEVER raises. A missing/empty ``FIREBASE_REFRESH_TOKEN`` resolves to ``None``
    (after a ``warn``) so the caller (the PAT verifier) fail-closes cleanly. Any
    unexpected error during client construction is likewise swallowed to ``None``.

    Builds a :class:`google.oauth2.credentials.Credentials` from the refresh token
    plus the public firebase-tools ``client_id``/``client_secret``, then hands it to
    ``firestore.Client(project="tenetx-qa-scores", credentials=...)`` — the same
    construction as ``mimic_connections`` (NOT ``firebase_admin.firestore``).
    """
    global _mcp_db_singleton

    # Re-checked on EVERY call, independent of the memoized client, so an unset token
    # always degrades to None even after the singleton was already built.
    refresh_token = os.environ.get("FIREBASE_REFRESH_TOKEN")
    if not refresh_token:
        log_event(
            logger,
            "warn",
            "get_mcp_firestore: FIREBASE_REFRESH_TOKEN not set; returning None "
            "(MCP PAT verification will fail-closed).",
        )
        return None

    if _mcp_db_singleton is not None:
        return _mcp_db_singleton

    try:
        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=FIREBASE_TOOLS_CLIENT_ID,
            client_secret=FIREBASE_TOOLS_CLIENT_SECRET,
        )
        _mcp_db_singleton = firestore.Client(
            project=FIREBASE_PROJECT_ID, credentials=creds
        )
        return _mcp_db_singleton
    except Exception as err:  # noqa: BLE001 — never throw; fail-closed to None
        log_event(
            logger,
            "warn",
            "get_mcp_firestore: Firestore client construction failed; returning None.",
            {"err": str(err)},
        )
        return None
