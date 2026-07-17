"""Firestore client for the MCP subsystem — same raw-``google-cloud-firestore``
construction as ``app/mimic_connections.py``, with its OWN module-level singleton.

The MCP PAT verifier (todo 3) and the ``mimic_*`` tools (todo 4) read Firestore
(``mcp_tokens``, ``mimic_features``, ``mcp_tool_calls``) with the SAME keyless
Keycloak-OIDC + GCP Workload Identity Federation credentials the SAML proxy uses.
This module hands them a client built exactly like ``mimic_connections._get_firestore``:

  * Google credentials from :func:`app.gcp_credentials.get_google_credentials`
    (Keycloak ``client_credentials`` → STS exchange via ``subject_token_supplier``),
    then
  * a RAW ``google.cloud.firestore.Client(project=..., credentials=...)``.

It deliberately does NOT use ``firebase_admin.firestore.client()``: that wrapper
broadens the credential's OAuth scopes in a way the federated credential's scoping
would fight, and the raw client with explicit ``Credentials`` is the construction
proven to work (documented at length in ``mimic_connections.py``).

WHY a private singleton here instead of importing ``mimic_connections._db_singleton``
(Metis N3): ``_db_singleton`` is a private, test-reset implementation detail of the
SAML per-tester lookup. Reaching into another module's private memo couples the two
subsystems' lifecycles (a test that resets one silently disturbs the other) and
imports a name the owning module never exported. The MCP subsystem owns its own
:data:`_mcp_db_singleton`; the two clients are identical in construction but
independent in lifetime.

NEVER throws. Unconfigured Keycloak/WIF credentials resolve to ``None`` (after a
structured ``warn``) so the verifier can fail-closed cleanly rather than 500. The
credentials are re-checked on EVERY call, independent of the memoized client, so an
unconfigured factory always degrades to ``None`` even after the singleton was built
by an earlier call while configured (parity with
``mimic_connections.get_mimic_idp_connection``).

Legacy note: this module NO LONGER reads ``FIREBASE_REFRESH_TOKEN`` — the
authorized_user refresh-token path was removed in favor of keyless WIF.
"""
from __future__ import annotations

from typing import Any, Optional

from google.cloud import firestore

from app.gcp_credentials import get_google_credentials, get_project_id
from app.logger import log_event, logger

__all__ = ["get_mcp_firestore"]

# MCP-owned memoized singleton, built on the FIRST successful construction only. A
# failed construction leaves this ``None`` so the next call retries. Independent of
# ``mimic_connections._db_singleton`` by design (see module docstring, Metis N3).
_mcp_db_singleton: Optional[Any] = None


def get_mcp_firestore() -> Optional[Any]:
    """Return a memoized RAW ``google.cloud.firestore.Client`` for the MCP subsystem,
    or ``None`` when Keycloak/WIF credentials are unconfigured.

    NEVER raises. Unconfigured credentials resolve to ``None`` (after a ``warn``) so
    the caller (the PAT verifier) fail-closes cleanly. Any unexpected error during
    client construction is likewise swallowed to ``None``.

    Builds Google credentials via :func:`get_google_credentials` (Keycloak OIDC +
    GCP WIF), then hands them to ``firestore.Client(project=..., credentials=...)`` —
    the same construction as ``mimic_connections`` (NOT ``firebase_admin.firestore``).
    """
    global _mcp_db_singleton

    # Re-checked on EVERY call, independent of the memoized client, so unconfigured
    # credentials always degrade to None even after the singleton was already built.
    creds = get_google_credentials()
    if creds is None:
        log_event(
            logger,
            "warn",
            "get_mcp_firestore: Google credentials not configured; returning None "
            "(MCP PAT verification will fail-closed).",
        )
        return None

    if _mcp_db_singleton is not None:
        return _mcp_db_singleton

    try:
        _mcp_db_singleton = firestore.Client(
            project=get_project_id(), credentials=creds
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
