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

Firestore-client construction mirrors the Node original exactly and deliberately
does NOT use ``firebase_admin.firestore``:

  * Node builds its own ``@google-cloud/firestore`` client from a
    ``UserRefreshClient`` because firebase-admin's Firestore wrapper is
    non-functional with this project's ``authorized_user`` refresh-token credential
    (mimicConnections.ts:33-52).
  * The SAME caveat applies in Python (an earlier port wrongly assumed it did not):
    ``firebase_admin.firestore.client()`` broadens the credential's OAuth scopes
    internally, which an ``authorized_user`` refresh token cannot satisfy — every
    read then dies in a ~300s retry storm ending in ``503 ... restricted_client:
    Unregistered scope(s) ... identitytoolkit ... devstorage.read_write ...
    datastore``. So we bypass that wrapper and build a RAW
    ``google.cloud.firestore.Client`` directly from a
    :class:`google.oauth2.credentials.Credentials` made from the same refresh token
    plus firebase-tools' public ``client_id``/``client_secret`` (imported from
    ``app/auth.py`` — the single source of those constants). That is the Python
    analogue of Node's ``UserRefreshClient`` path and the only construction proven to
    work with this credential (~0.8s vs the 300s failure).

:func:`app.auth.init_firebase_app` is still bootstrapped once at startup
(``app/main.py``) for Firebase Auth ID-token verification on ``/verify-metadata``,
but this module no longer depends on it for Firestore access.

The env ``FIREBASE_REFRESH_TOKEN`` is re-checked on EVERY call, independent of the
memoized client, so an unset token always degrades to ``None`` even after the
singleton was already built by an earlier call with the token present
(mimicConnections.ts:72-81).
"""
from __future__ import annotations

import os
from typing import Any, Optional, TypedDict

from google.cloud import firestore
from google.oauth2.credentials import Credentials

from app.auth import (
    FIREBASE_PROJECT_ID,
    FIREBASE_TOOLS_CLIENT_ID,
    FIREBASE_TOOLS_CLIENT_SECRET,
)
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


def _get_firestore(refresh_token: str) -> Any:
    """Return a memoized RAW ``google.cloud.firestore.Client`` authenticated with the
    firebase-tools ``authorized_user`` refresh-token credential. Port of
    ``getFirestore`` (mimicConnections.ts:43-52).

    Builds a :class:`google.oauth2.credentials.Credentials` from ``refresh_token``
    plus the public firebase-tools ``client_id``/``client_secret`` (imported from
    ``app/auth.py``), then hands it to ``firestore.Client(project=..., credentials=...)``.

    Deliberately does NOT use ``firebase_admin.firestore.client()``: that wrapper
    broadens the credential's OAuth scopes in a way an ``authorized_user`` refresh
    token cannot satisfy, producing a ~300s retry storm / ``restricted_client`` 503.
    A raw client with an explicit ``Credentials`` bypasses that broadening entirely —
    the same reason Node uses ``UserRefreshClient`` over firebase-admin's wrapper.
    """
    global _db_singleton
    if _db_singleton is not None:
        return _db_singleton
    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=FIREBASE_TOOLS_CLIENT_ID,
        client_secret=FIREBASE_TOOLS_CLIENT_SECRET,
    )
    _db_singleton = firestore.Client(project=FIREBASE_PROJECT_ID, credentials=creds)
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
        db = _get_firestore(refresh_token)
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
