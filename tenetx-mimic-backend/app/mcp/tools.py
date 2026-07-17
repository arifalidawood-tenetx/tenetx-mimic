"""The ``mimic_*`` MCP tools + a best-effort ``mcp_tool_calls`` audit log
(working-mcp-pat todo 4).

Three read-only tools, registered on the shared :data:`app.mcp.server.mcp`
instance by :func:`register_tools` (called from ``app.mcp.server`` at import time,
BEFORE ``app.mcp.lifespan`` builds the Streamable HTTP app — tools registered
after ``http_app()`` would not be exposed):

  * ``mimic_health``       — liveness + whether the Firestore client is configured.
  * ``mimic_list_features``— every ``mimic_features`` doc, sanitized to the same
    display fields the frontend's ``toMimicFeature`` narrows to.
  * ``mimic_get_feature``  — a single ``mimic_features`` doc by id.

Tool NAMES are underscore-only (``^[a-zA-Z0-9_-]+$``). There are deliberately NO
slash-named tools (no ``simenv/create`` etc.) and no simulation engines — this todo
is inspection-only.

AUDIT LOG. Every tool call is recorded, best-effort, into the ``mcp_tool_calls``
Firestore collection with the SAME field names (camelCase) the frontend
``McpToolCall`` interface reads (``tool``, ``client``, ``statusCode``,
``durationMs``, ``tokenId``, ``requestSummary``, ``createdAt``). The write is
best-effort in the strong sense: unconfigured Keycloak/WIF credentials (no client),
a Firestore error, or a missing auth context can NEVER fail the tool — the failure
is swallowed to a ``warn`` and the tool's result is returned regardless.

AUTH COORDINATION. The PAT verifier (:class:`app.mcp.auth.McpAccessTokenVerifier`)
populates the caller's :class:`AccessToken` with ``claims["token_id"]``. When a
tool is invoked outside an HTTP/auth context (unit tests, missing gate),
:func:`_safe_access_token` returns ``None`` and the audit row records
``client="unknown"`` / ``tokenId=None``.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastmcp import FastMCP

from app.logger import log_event, logger
from app.mcp.firestore_client import get_mcp_firestore

__all__ = ["register_tools"]

FEATURES_COLLECTION = "mimic_features"
TOOL_CALLS_COLLECTION = "mcp_tool_calls"

# The three tagged feature statuses (parity with the frontend ``isFeatureStatus``
# guard in src/lib/types.ts). Anything else sanitizes to "planned".
_VALID_STATUSES = ("planned", "in-progress", "done")


def _safe_access_token() -> Optional[Any]:
    """Return the current FastMCP :class:`AccessToken`, or ``None`` — never raises.

    ``get_access_token()`` raises when there is no request/context (e.g. a direct
    unit-test call, or a tool invoked outside an HTTP session). The audit log must
    degrade cleanly in every one of those cases, so all errors resolve to ``None``.
    """
    try:
        from fastmcp.server.dependencies import get_access_token

        return get_access_token()
    except Exception:  # noqa: BLE001 — audit is best-effort; no context -> None
        return None


def _record_tool_call(
    *, tool: str, status_code: int, duration_ms: int, request_summary: Optional[str]
) -> None:
    """Best-effort write of one ``mcp_tool_calls`` audit row. NEVER raises.

    Field names are the camelCase the frontend ``McpToolCall`` interface reads. A
    missing Firestore client (unconfigured Keycloak/WIF) or ANY write error
    is swallowed to a ``warn`` so an audit failure can never fail the tool call.
    """
    try:
        db = get_mcp_firestore()
        if db is None:
            # No client (token unset / construction failed). Best-effort: skip the
            # audit row rather than fail the tool — get_mcp_firestore already warned.
            return

        token = _safe_access_token()
        client = "unknown"
        token_id: Optional[str] = None
        if token is not None:
            client = getattr(token, "client_id", None) or "unknown"
            claims = getattr(token, "claims", None) or {}
            raw_token_id = claims.get("token_id")
            token_id = raw_token_id if isinstance(raw_token_id, str) else None

        db.collection(TOOL_CALLS_COLLECTION).add(
            {
                "tool": tool,
                "client": client,
                "statusCode": status_code,
                "durationMs": duration_ms,
                "tokenId": token_id,
                "requestSummary": request_summary,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        )
    except Exception as err:  # noqa: BLE001 — audit write must never fail the tool
        log_event(
            logger,
            "warn",
            "mcp audit write failed; tool result unaffected.",
            {"tool": tool, "err": str(err)},
        )


def _run_tool(
    tool: str,
    request_summary: Optional[str],
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> dict[str, Any]:
    """Run a tool body, time it, and record the audit row in a ``finally``.

    ``fn`` returns ``(status_code, payload)``; the caller (the MCP client) sees only
    ``payload``. On an unexpected exception the audit row records ``statusCode=500``
    and the exception re-raises. The audit write itself is best-effort (see
    :func:`_record_tool_call`) and cannot alter the tool outcome.
    """
    start = time.monotonic()
    status_code = 500
    try:
        status_code, payload = fn()
        return payload
    finally:
        duration_ms = int((time.monotonic() - start) * 1000)
        _record_tool_call(
            tool=tool,
            status_code=status_code,
            duration_ms=duration_ms,
            request_summary=request_summary,
        )


def _is_int(value: Any) -> bool:
    """True only for a real int — ``bool`` is an ``int`` subclass and is excluded."""
    return isinstance(value, int) and not isinstance(value, bool)


def _summarize_feature(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    """Narrow one raw ``mimic_features`` doc to the display fields, mirroring the
    frontend ``toMimicFeature`` sanitizer (src/pages/DashboardPage.tsx): each
    missing/wrong-typed field falls back to the SAME default so a malformed doc
    never breaks the listing."""
    status = data.get("status")
    return {
        "id": doc_id,
        "ticketId": data["ticketId"] if isinstance(data.get("ticketId"), str) else "UNKNOWN",
        "featureSlug": data["featureSlug"] if isinstance(data.get("featureSlug"), str) else "",
        "attemptNumber": data["attemptNumber"] if _is_int(data.get("attemptNumber")) else 0,
        "title": data["title"] if isinstance(data.get("title"), str) else "Untitled feature",
        "status": status if status in _VALID_STATUSES else "planned",
        "routePath": data["routePath"] if isinstance(data.get("routePath"), str) else "/",
    }


def _health() -> tuple[int, dict[str, Any]]:
    """Body of ``mimic_health``: liveness + whether Firestore is configured."""
    db = get_mcp_firestore()
    return 200, {
        "status": "ok",
        "service": "tenetx-mimic-mcp",
        "firestoreConfigured": db is not None,
    }


def _list_features() -> tuple[int, dict[str, Any]]:
    """Body of ``mimic_list_features``: every ``mimic_features`` doc, sanitized.

    With no Firestore client (token unset) this returns an empty list rather than
    erroring — the tool stays usable in a mis-provisioned environment.
    """
    db = get_mcp_firestore()
    if db is None:
        return 200, {"features": [], "count": 0, "firestoreConfigured": False}

    features = [
        _summarize_feature(doc.id, doc.to_dict() or {})
        for doc in db.collection(FEATURES_COLLECTION).stream()
    ]
    return 200, {"features": features, "count": len(features)}


def _get_feature(feature_id: str) -> tuple[int, dict[str, Any]]:
    """Body of ``mimic_get_feature``: one ``mimic_features`` doc by id.

    Returns ``found: False`` (status 404) for a missing doc and status 503 when no
    Firestore client is configured — never raises, so the audit row is always the
    honest outcome and the MCP client gets a structured result either way.
    """
    db = get_mcp_firestore()
    if db is None:
        return 503, {
            "found": False,
            "featureId": feature_id,
            "error": "Firestore not configured",
        }

    snap = db.collection(FEATURES_COLLECTION).document(feature_id).get()
    if not snap.exists:
        return 404, {"found": False, "featureId": feature_id}

    data = snap.to_dict() or {}
    return 200, {"found": True, "feature": {"id": snap.id, **data}}


def register_tools(mcp: FastMCP) -> None:
    """Register the three ``mimic_*`` tools on ``mcp``.

    Called by ``app.mcp.server`` right after the ``mcp`` instance is created, so the
    tools exist BEFORE ``app.mcp.lifespan.get_mcp_http_app()`` freezes the Streamable
    HTTP app. Idempotent enough for a single process: FastMCP registers each tool by
    name on decoration.
    """

    @mcp.tool(
        name="mimic_health",
        description=(
            "Liveness probe for the TenetX Mimic MCP server. Returns status 'ok' "
            "and whether the backend Firestore client is configured."
        ),
    )
    def mimic_health() -> dict[str, Any]:
        return _run_tool("mimic_health", None, _health)

    @mcp.tool(
        name="mimic_list_features",
        description=(
            "List every tracked mimic feature (the mimic_features collection): "
            "id, ticketId, featureSlug, attemptNumber, title, status, routePath."
        ),
    )
    def mimic_list_features() -> dict[str, Any]:
        return _run_tool("mimic_list_features", "list mimic_features", _list_features)

    @mcp.tool(
        name="mimic_get_feature",
        description=(
            "Fetch a single mimic feature by its Firestore document id. Returns "
            "{found: false} if no such feature exists."
        ),
    )
    def mimic_get_feature(feature_id: str) -> dict[str, Any]:
        return _run_tool(
            "mimic_get_feature",
            f"feature_id={feature_id}",
            lambda: _get_feature(feature_id),
        )
