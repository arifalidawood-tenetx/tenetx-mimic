"""RelayState codec — ported byte-for-byte from
``tenetx-mimic-backend/src/relayState.ts``.

RelayState is the one value a SAML IdP echoes back verbatim to the stateless
``/saml/acs`` (login) and ``/saml/sls`` (logout) callbacks, so it is the only
channel that can carry which tester's IdP identity a callback belongs to. Two
modes, exactly as in the Node original (relayState.ts:1-34):

  - **Bare URL (legacy):** the RelayState string IS the ``returnUrl``, unchanged.
  - **Composite:** ``"mimicrs:" + base64url(JSON.stringify({returnUrl,
    connectionDocId}))``, where ``connectionDocId`` references the tester's own
    already-persisted ``mimic_idp_connections`` Firestore doc.

The ``"mimicrs:"`` prefix is a deliberate unambiguous marker: a bare returnUrl
(always a real absolute URL) can never start with it, so the two decode paths
can never collide.

This codec mirrors ``status_token.py``'s base64url + JSON style but is
INTENTIONALLY UNSIGNED — no HMAC (relayState.ts:16-31). See that module header
for the full rationale; the short version is that ``connectionDocId`` is only a
reference to an already-existing doc and ``returnUrl``'s origin is independently
re-checked downstream, so signing would add cost without closing a real gap.

Wire-format parity notes (why this decodes/encodes byte-identically to Node):

  * **base64url with NO padding.** Node's ``Buffer.from(x).toString('base64url')``
    emits the URL-safe alphabet (``-``/``_``) and strips ``=`` padding; Python's
    ``base64.urlsafe_b64encode`` pads, so we ``rstrip(b"=")`` to match.
  * **Compact JSON.** ``JSON.stringify`` emits no spaces after ``:``/``,`` and
    preserves insertion order (``returnUrl`` then ``connectionDocId``);
    ``json.dumps(..., separators=(",", ":"), ensure_ascii=False)`` is the exact
    equivalent (default ``ensure_ascii=True`` would escape non-ASCII to
    ``\\uXXXX`` and diverge from Node's literal UTF-8 output).
"""
from __future__ import annotations

import base64
import json
from typing import Any, Mapping, Optional

__all__ = ["COMPOSITE_PREFIX", "encode_relay_state", "decode_relay_state"]

# Unambiguous composite marker. A bare returnUrl can never begin with this.
# (relayState.ts:34)
COMPOSITE_PREFIX = "mimicrs:"


def _b64url_encode_nopad(data: bytes) -> str:
    """base64url with padding stripped — matches Node ``.toString('base64url')``."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    """Decode base64url, re-adding the ``=`` padding Node omits. Matches
    ``Buffer.from(value, 'base64url')`` for the well-formed inputs this codec
    produces; malformed input raises, and the sole caller treats any raise as a
    fall-through to bare-URL handling (mirroring the Node ``try/catch``)."""
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def encode_relay_state(payload: Mapping[str, Any]) -> str:
    """Build a RelayState string. Port of relayState.ts:39-50.

    With no ``connectionDocId`` (absent or empty), returns ``returnUrl`` verbatim
    (byte-identical to today's Node behavior). With one, returns the
    ``"mimicrs:"``-prefixed composite carrying both fields. Unsigned by design.
    """
    return_url = payload.get("returnUrl")
    connection_doc_id = payload.get("connectionDocId")
    # JS `if (!connectionDocId)` — None AND empty-string are both falsy, so both
    # take the legacy bare-URL path.
    if not connection_doc_id:
        return return_url  # type: ignore[return-value]
    json_str = json.dumps(
        {"returnUrl": return_url, "connectionDocId": connection_doc_id},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return f"{COMPOSITE_PREFIX}{_b64url_encode_nopad(json_str.encode('utf-8'))}"


def decode_relay_state(raw: Any) -> Optional[dict[str, str]]:
    """Parse a RelayState string. Port of relayState.ts:60-88.

    Returns ``None`` only for empty/non-string input. A ``"mimicrs:"``-prefixed
    value is decoded as a composite; on ANY failure in that branch (bad base64,
    bad JSON, missing/wrong-typed ``returnUrl``) it falls THROUGH to bare-URL
    treatment rather than returning ``None``, so a malformed prefixed value
    degrades to a plain ``returnUrl`` instead of dropping the redirect entirely.
    Any value without the prefix is treated as a bare legacy ``returnUrl``.
    """
    if not isinstance(raw, str) or len(raw) == 0:
        return None

    if raw.startswith(COMPOSITE_PREFIX):
        try:
            decoded = _b64url_decode(raw[len(COMPOSITE_PREFIX):]).decode("utf-8")
            parsed = json.loads(decoded)
            # JS: typeof parsed === 'object' && parsed !== null && !Array.isArray
            # -> a plain dict in Python (list/str/int/None all fail isinstance).
            if isinstance(parsed, dict):
                return_url = parsed.get("returnUrl")
                if isinstance(return_url, str) and len(return_url) > 0:
                    connection_doc_id = parsed.get("connectionDocId")
                    if isinstance(connection_doc_id, str) and len(connection_doc_id) > 0:
                        return {"returnUrl": return_url, "connectionDocId": connection_doc_id}
                    return {"returnUrl": return_url}
        except Exception:
            # Malformed composite — fall through to bare-URL treatment below.
            pass

    # Bare legacy returnUrl (or fall-through from a failed composite decode).
    return {"returnUrl": raw}
