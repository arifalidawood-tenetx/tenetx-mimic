"""Firestore ``mimic_idp_connections`` lookup — ported from
tenetx-mimic-backend/src/mimicConnections.ts (``getMimicIdpConnection``).

A server-side read of a single per-connection IdP identity from the
``mimic_idp_connections`` Firestore collection — the same doc the Try-It-Out
wizard writes on realm verification. Called from WITHIN the ``/saml/*`` route
handlers (todos 9/10) to fetch a per-tester IdP override; it is NOT an
HTTP-request-scoped auth check, so it deliberately does NOT import
``require_tenetx_user`` (mimicConnections.ts is a plain module, not middleware).

NEVER throws. Unconfigured Keycloak/WIF credentials, a missing doc, a doc with no
``entity_id``, or ANY Firestore error all resolve to ``None`` (after a warn).
Callers treat ``None`` as "no per-tester override" and fall back to their existing
behavior (mimicConnections.ts:58-66).

Firestore-client construction mirrors the Node original's intent and deliberately
does NOT use ``firebase_admin.firestore``:

  * Node builds its own ``@google-cloud/firestore`` client from an explicit
    credential because firebase-admin's Firestore wrapper broadens OAuth scopes in a
    way this project's federated credential fights (mimicConnections.ts:33-52).
  * So we bypass that wrapper and build a RAW ``google.cloud.firestore.Client``
    directly from the keyless Google credentials produced by
    :func:`app.gcp_credentials.get_google_credentials` (Keycloak ``client_credentials``
    → GCP STS exchange via ``subject_token_supplier``). That is the only construction
    proven to work with this credential.

:func:`app.auth.init_firebase_app` is still bootstrapped once at startup
(``app/main.py``) for Firebase Auth ID-token verification on ``/verify-metadata``,
but this module no longer depends on it for Firestore access.

The Google credentials are re-resolved on EVERY call, independent of the memoized
client, so unconfigured credentials always degrade to ``None`` even after the
singleton was already built by an earlier call while configured
(mimicConnections.ts:72-81).

Legacy note: this module NO LONGER reads ``FIREBASE_REFRESH_TOKEN`` — the
authorized_user refresh-token path was removed in favor of keyless WIF.
"""
from __future__ import annotations

from typing import Any, Optional, TypedDict

from google.cloud import firestore

from app.gcp_credentials import get_google_credentials, get_project_id
from app.logger import log_event, logger

__all__ = [
    "COLLECTION",
    "MimicIdpConnection",
    "get_mimic_idp_connection",
]

# Same collection name the Node backend + the Try-It-Out wizard use
# (mimicConnections.ts:31). Do not drift — the doc shape is a shared contract.
COLLECTION = "mimic_idp_connections"


class MimicIdpConnection(TypedDict):
    """Per-connection IdP identity — parity with mimicConnections.ts:12-17.

    All four are strings; an absent or wrong-typed value coerces to the empty
    string, never ``None`` (mirrors the Node ``coerceString`` empty-string
    convention, mimicConnections.ts:54-56).
    """

    entity_id: str
    sso_url: str
    slo_url: str
    certificate: str


# Memoized module-level singleton, built on the FIRST successful construction only
# (parity with mimicConnections.ts:41-52). A failed construction leaves this ``None``
# so the next call retries. Named ``_db_singleton`` — the test suite's ``driver``
# fixture resets it via ``monkeypatch.setattr(mimic_connections, "_db_singleton", None)``.
_db_singleton: Optional[Any] = None


def _coerce_string(value: Any) -> str:
    """Port of ``coerceString`` (mimicConnections.ts:54-56): a non-string (absent,
    number, ``None``, …) becomes ``''``. ``typeof value === 'string' ? value : ''``."""
    return value if isinstance(value, str) else ""


def _get_firestore(credentials: Any) -> Any:
    """Return a memoized RAW ``google.cloud.firestore.Client`` authenticated with the
    keyless Keycloak-OIDC + GCP WIF credentials. Port of ``getFirestore``
    (mimicConnections.ts:43-52).

    Hands the credentials produced by :func:`get_google_credentials` to
    ``firestore.Client(project=..., credentials=...)``.

    Deliberately does NOT use ``firebase_admin.firestore.client()``: that wrapper
    broadens the credential's OAuth scopes in a way the federated credential fights.
    A raw client with an explicit credential bypasses that broadening entirely — the
    same reason Node uses an explicit credential over firebase-admin's wrapper.
    """
    global _db_singleton
    if _db_singleton is not None:
        return _db_singleton
    _db_singleton = firestore.Client(project=get_project_id(), credentials=credentials)
    return _db_singleton


def get_mimic_idp_connection(connection_doc_id: str) -> Optional[MimicIdpConnection]:
    """Look up a single ``mimic_idp_connections`` doc by ID and return its IdP
    identity, or ``None`` when unavailable. Port of
    ``getMimicIdpConnection`` (mimicConnections.ts:68-119).

    NEVER raises. Unconfigured Keycloak/WIF credentials, a missing doc, a doc
    without an ``entity_id``, or ANY Firestore error all resolve to ``None`` (after
    a structured ``warn``).
    """
    # Re-resolved on EVERY call, independent of the memoized client, so unconfigured
    # credentials always degrade to None — even after the singleton was already built
    # by an earlier call while configured (mimicConnections.ts:72-81).
    creds = get_google_credentials()
    if creds is None:
        log_event(
            logger,
            "warn",
            "getMimicIdpConnection: Google credentials not configured; returning null "
            "(no per-tester IdP override).",
        )
        return None

    try:
        db = _get_firestore(creds)
        snap = db.collection(COLLECTION).document(connection_doc_id).get()

        # DocumentSnapshot.exists is a bool property; .to_dict() returns the fields
        # dict or None (google-cloud-firestore), mirroring the Node snap.exists /
        # snap.data() pair (mimicConnections.ts:85-95).
        if not snap.exists:
            log_event(
                logger,
                "warn",
                "getMimicIdpConnection: no mimic_idp_connections doc found; returning null.",
                {"connectionDocId": connection_doc_id},
            )
            return None

        # `snap.data() ?? {}` is nullish — an empty object stays empty, not None.
        data = snap.to_dict()
        if data is None:
            data = {}
        entity_id = _coerce_string(data.get("entity_id"))

        # An entity_id-less "connection" is unusable as a SAML IdP identity
        # (mimicConnections.ts:98-105).
        if not entity_id:
            log_event(
                logger,
                "warn",
                "getMimicIdpConnection: doc has no entity_id; returning null.",
                {"connectionDocId": connection_doc_id},
            )
            return None

        return {
            "entity_id": entity_id,
            "sso_url": _coerce_string(data.get("sso_url")),
            "slo_url": _coerce_string(data.get("slo_url")),
            "certificate": _coerce_string(data.get("certificate")),
        }
    except Exception as err:  # noqa: BLE001 — parity with mimicConnections.ts:113 catch-all
        log_event(
            logger,
            "warn",
            "getMimicIdpConnection: Firestore lookup failed; returning null.",
            {"connectionDocId": connection_doc_id, "err": str(err)},
        )
        return None
