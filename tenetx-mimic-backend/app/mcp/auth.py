"""FastMCP ``TokenVerifier`` for MCP personal access tokens (inbound MCP auth).

This verifier gates every request to the ``/mcp`` mount behind a Bearer PAT that
was minted client-side by ``src/lib/mcpTokens.ts`` and stored (hash only) in the
Firestore ``mcp_tokens`` collection. It re-derives
``sha256(raw_token).hexdigest()`` from the incoming Bearer token and matches it
against the stored ``tokenHash`` — byte-for-byte the same scheme the frontend
uses (``mcpTokens.ts`` ``sha256`` returns lowercase hex), so a token minted there
verifies here. Keep the two in lock-step.

Security posture (the single most important property in this module):

* **Fail-closed.** ``verify_token`` wraps its ENTIRE body in ``try/except``: on
  ANY error (Firestore unavailable, ``get_mcp_firestore()`` returning ``None``, a
  malformed ``expiresAt``, a mid-query failure, a bug) it logs and returns
  ``None``. It NEVER lets an exception propagate — a 500 could be misread by a
  transport as "let through".
* **Per-request, no caching.** Each call runs a SINGLE indexed equality lookup
  ``where tokenHash == <hash>`` against ``mcp_tokens``. No result caching across
  requests — deliberately chosen over caching for security.
* **Authoritative identity.** The returned claims come exclusively from the
  matched Firestore document. Nothing in the incoming token string is trusted
  beyond using it to compute the hash for the lookup.

Firestore is the RAW synchronous ``google.cloud.firestore.Client`` from
:func:`app.mcp.firestore_client.get_mcp_firestore` (``None`` when Keycloak/WIF
credentials are unconfigured — which fail-closes here). The blocking query
runs via ``asyncio.to_thread`` under a hard timeout (``_QUERY_TIMEOUT_SECONDS``):
a stale/expired credential (e.g. an expired federated token) can make
the underlying grpc auth retry for a long time, and running that inline on the
event loop previously froze the ENTIRE server — every route, not just
``/mcp`` — until it gave up. The timeout bounds that to one fail-closed
request instead of a full outage.

Scopes are recorded in ``claims`` but NOT enforced in v1 (documented plan
limitation): the returned ``AccessToken`` carries ``scopes=[]`` so FastMCP's
scope gate never rejects, while the token's real scope list is surfaced under
``claims["scopes"]`` for tools that want to inspect it.
"""
from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastmcp.server.auth import AccessToken, TokenVerifier
from google.cloud.firestore_v1.base_query import FieldFilter

from app.logger import log_event, logger
from app.mcp.firestore_client import get_mcp_firestore

__all__ = ["McpAccessTokenVerifier"]

_MCP_TOKENS_COLLECTION = "mcp_tokens"

# Bounds the blocking Firestore query (see module docstring): a stale/expired
# credential can otherwise hang far longer than any caller would wait.
_QUERY_TIMEOUT_SECONDS = 3.0


class McpAccessTokenVerifier(TokenVerifier):
    """Firestore-backed, fail-closed, per-request verifier for MCP Bearer PATs."""

    def __init__(
        self,
        db: Optional[Any] = None,
        now_fn: Optional[Callable[[], datetime]] = None,
    ) -> None:
        """Initialize the verifier.

        Args:
            db: A Firestore client to use for lookups. When ``None`` (the default,
                as used when mounting the MCP app), it is resolved lazily
                per-request via :func:`get_mcp_firestore` so construction never
                touches Firestore or credentials. Injected in tests.
            now_fn: Callable returning the current time for expiry comparison and
                the ``lastUsedAt`` stamp. Defaults to a tz-aware
                ``datetime.now(timezone.utc)``; injected for deterministic tests.
                MUST return a tz-aware value.
        """
        super().__init__()
        self._db = db
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    @staticmethod
    def _hash_token(token: str) -> str:
        """Compute ``sha256(token).hexdigest()`` — lowercase hex.

        Must stay byte-for-byte consistent with the frontend ``mcpTokens.ts``
        ``sha256`` helper so a token minted in the browser verifies here.
        """
        return hashlib.sha256(token.encode()).hexdigest()

    async def verify_token(self, token: str) -> AccessToken | None:
        """Verify a Bearer token against ``mcp_tokens``; fail-closed on any error.

        Runs PER-REQUEST with no caching. Returns an ``AccessToken`` carrying the
        matched document's ``token_id``/``scopes``/``name`` in ``claims`` only
        when a row matches the hash AND is neither revoked nor expired; returns
        ``None`` in every other case, including on ANY exception.

        Args:
            token: The raw Bearer token string from the incoming request.

        Returns:
            An ``AccessToken`` with ``claims={"token_id", "scopes", "name"}`` on
            success, else ``None``. Never raises.
        """
        try:
            token_hash = self._hash_token(token)
            db = self._db or get_mcp_firestore()
            if db is None:
                # No Firestore (e.g. Keycloak/WIF unconfigured) -> fail-closed.
                return None

            query = (
                db.collection(_MCP_TOKENS_COLLECTION)
                .where(filter=FieldFilter("tokenHash", "==", token_hash))
                .limit(1)
            )
            docs = await asyncio.wait_for(
                asyncio.to_thread(lambda: list(query.stream())),
                timeout=_QUERY_TIMEOUT_SECONDS,
            )
            if not docs:
                return None

            snapshot = docs[0]
            data = snapshot.to_dict() or {}

            if data.get("revoked") is True:
                return None
            if self._is_expired(data.get("expiresAt")):
                return None

            # Capture authoritative identity BEFORE the best-effort write, so a
            # write failure can never affect what we return.
            token_id = snapshot.id
            scopes = data.get("scopes") or []
            name = data.get("name")

            self._touch_last_used(snapshot)

            return AccessToken(
                token=token,
                client_id=token_id,
                # scopes=[] so FastMCP's scope gate never rejects (no enforcement
                # in v1); the real scope list lives in claims for inspection.
                scopes=[],
                claims={"token_id": token_id, "scopes": scopes, "name": name},
            )
        except Exception as err:  # noqa: BLE001 — fail-closed: deny on ANY error.
            # Do not log the token or hash. Never propagate (no 500 that a
            # transport could misconstrue as "let through").
            log_event(
                logger,
                "warn",
                "MCP token verification failed; denying access (fail-closed).",
                {"err": str(err)},
            )
            return None

    def _is_expired(self, expires_at: Any) -> bool:
        """Return whether the JS ``Date.toISOString()`` ``expiresAt`` is past.

        The frontend stores ``expiresAt`` as ``2026-12-31T00:00:00.000Z`` (a
        ``Z``-suffixed ISO string). Python's ``datetime.fromisoformat`` rejects
        the literal ``Z`` on 3.10, so ``Z`` is replaced with ``+00:00`` before
        parsing (works on 3.10 and 3.11+ alike). The comparison ``now`` is
        tz-aware UTC — NEVER a naive ``datetime.utcnow()`` (aware-vs-naive would
        raise ``TypeError``, which the outer handler would fail-closed anyway,
        but the correct comparison must never rely on that).

        A missing or non-string ``expiresAt`` is treated as expired
        (fail-closed): every legitimately minted token carries one. A malformed
        string raises out of ``fromisoformat`` and is caught by
        :meth:`verify_token`, likewise denying access.
        """
        if not isinstance(expires_at, str) or not expires_at:
            return True
        normalized = expires_at.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed <= self._now_fn()

    def _touch_last_used(self, snapshot: Any) -> None:
        """Best-effort ``lastUsedAt`` bump; a failure here never blocks auth.

        The auth decision is already made by the time this runs. Its own
        ``try/except`` guarantees a write failure cannot escape to fail the
        verification. The stamp is written in the same ``Z``-suffixed ISO shape
        the frontend uses for the field.
        """
        try:
            stamp = self._now_fn().isoformat().replace("+00:00", "Z")
            snapshot.reference.update({"lastUsedAt": stamp})
        except Exception as err:  # noqa: BLE001 — best-effort; auth already granted.
            log_event(
                logger,
                "warn",
                "Failed to update lastUsedAt for MCP token; auth still granted.",
                {"err": str(err)},
            )
