"""Firestore ``mimic_idp_connections`` lookup — ported from
tenetx-mimic-backend/src/mimicConnections.ts (``getMimicIdpConnection``).

A server-side read of a single per-connection IdP identity from the
``mimic_idp_connections`` Firestore collection — the same doc the Try-It-Out
wizard writes on realm verification. Called from WITHIN the ``/saml/*`` route
handlers (todos 9/10) to fetch a per-tester IdP override; it is NOT an
HTTP-request-scoped auth check, so it deliberately does NOT import
``require_tenetx_user`` (mimicConnections.ts is a plain module, not middleware).

NEVER throws. An unset ``FIREBASE_REFRESH_TOKEN``, a missing doc, a doc with no
``entity_id``, or ANY Firestore error all resolve to ``None`` (after a warn).
Callers treat ``None`` as "no per-tester override" and fall back to their existing
behavior (mimicConnections.ts:58-66).

Firestore-client construction differs from the Node original by design:

  * Node builds its own ``@google-cloud/firestore`` client from a
    ``UserRefreshClient`` because firebase-admin's Firestore wrapper was
    documented non-functional there (mimicConnections.ts:33-52).
  * Here we reuse the ALREADY-bootstrapped default Firebase Admin app: this module
    imports and calls :func:`app.auth.init_firebase_app` (idempotent — todo 5),
    then gets a ``google.cloud.firestore.Client`` off that same default app via
    ``firebase_admin.firestore.client()``. That avoids duplicating the
    refresh-token credential wiring, which now lives in exactly one place
    (``app/auth.py``). The credential itself is identical (the same firebase-tools
    ``authorized_user`` refresh token), so the Firestore reads authenticate the
    same way.

The env ``FIREBASE_REFRESH_TOKEN`` is re-checked on EVERY call, independent of the
memoized client, so an unset token always degrades to ``None`` even after the
singleton was already built by an earlier call with the token present
(mimicConnections.ts:72-81).
"""
from __future__ import annotations

import os
from typing import Any, Optional, TypedDict

from firebase_admin import firestore

from app.auth import init_firebase_app
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


# Memoized module-level singleton, built off the shared default Firebase app on the
# FIRST successful construction only (parity with mimicConnections.ts:41-52). A
# failed construction leaves this ``None`` so the next call retries.
_db_singleton: Optional[Any] = None


def _coerce_string(value: Any) -> str:
    """Port of ``coerceString`` (mimicConnections.ts:54-56): a non-string (absent,
    number, ``None``, …) becomes ``''``. ``typeof value === 'string' ? value : ''``."""
    return value if isinstance(value, str) else ""


def _get_firestore() -> Any:
    """Return a memoized ``google.cloud.firestore.Client`` built off the shared
    default Firebase Admin app.

    Calls :func:`init_firebase_app` (idempotent — todo 5) FIRST so the default app
    exists, then ``firebase_admin.firestore.client()`` derives a Firestore client
    from it. This is the ONLY place a Firestore client is constructed; the
    refresh-token credential wiring is NOT duplicated here (it lives in
    ``app/auth.py``).
    """
    global _db_singleton
    if _db_singleton is not None:
        return _db_singleton
    # Ensure the default Firebase Admin app is initialized (idempotent). We do NOT
    # re-implement the credential; app/auth.py owns that.
    init_firebase_app()
    _db_singleton = firestore.client()
    return _db_singleton


def get_mimic_idp_connection(connection_doc_id: str) -> Optional[MimicIdpConnection]:
    """Look up a single ``mimic_idp_connections`` doc by ID and return its IdP
    identity, or ``None`` when unavailable. Port of
    ``getMimicIdpConnection`` (mimicConnections.ts:68-119).

    NEVER raises. A missing/empty ``FIREBASE_REFRESH_TOKEN``, a missing doc, a doc
    without an ``entity_id``, or ANY Firestore error all resolve to ``None`` (after
    a structured ``warn``).
    """
    # Re-checked on EVERY call, independent of the memoized client, so an unset
    # token always degrades to None — even after the singleton was already built by
    # an earlier call with the token present (mimicConnections.ts:72-81).
    refresh_token = os.environ.get("FIREBASE_REFRESH_TOKEN")
    if not refresh_token:
        log_event(
            logger,
            "warn",
            "getMimicIdpConnection: FIREBASE_REFRESH_TOKEN not set; returning null "
            "(no per-tester IdP override).",
        )
        return None

    try:
        db = _get_firestore()
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
