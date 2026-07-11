"""Signed status token — ported byte-for-byte from
``tenetx-mimic-backend/src/statusToken.ts``.

A signed, short-lived status token hands a SAML verdict back to the SPA through a
redirect query param (consumed by ``/saml/acs`` and ``/saml/sls``). This is NOT a
session credential: it carries no Firebase UID / session identifier and is only
trusted for the 5-minute window after it is minted.

    Token shape: base64url(JSON.stringify(payload)) + "." + hmacSha256Hex(secret, base64urlPart)

The frontend's ``decodeStatusToken`` (src/pages/TryItOutPage.tsx:81-99) consumes
the same shape: it splits on ``"."``, base64url-decodes the FIRST part, and
``JSON.parse``s it. So the payload half must be exactly ``base64url(compact JSON)``
for the SPA to read it unchanged — which is what this module emits.

Wire-format parity notes (why tokens are cross-compatible with the Node signer
given the same ``MIMIC_STATUS_SECRET``):

  * **HMAC-SHA256, hex digest.** Node ``createHmac('sha256', SECRET).update(base64)
    .digest('hex')``. The key is the secret STRING encoded as UTF-8 (Node's
    default for a string key); the message is the base64url part, also UTF-8
    (ASCII in practice). ``hmac.new(SECRET.encode('utf-8'), base64.encode('utf-8'),
    hashlib.sha256).hexdigest()`` is byte-identical.
  * **base64url, NO padding** — see ``relay_state.py`` header; ``rstrip(b"=")``.
  * **Compact, ordered JSON.** ``{**payload, "iat": _now_ms()}`` stamps ``iat``
    LAST (dicts preserve insertion order); ``json.dumps(..., separators=(",",":"),
    ensure_ascii=False)`` matches ``JSON.stringify`` spacing/escaping.
  * **``iat`` is integer epoch milliseconds.** ``Date.now()`` is an integer;
    ``int(time.time() * 1000)`` matches (a float would serialize with a trailing
    ``.0`` and break byte-identity + the HMAC).

Testability note: ``SECRET`` is read from the environment ONCE at import (mirroring
statusToken.ts:18-22 and index.ts's module-level env pattern). ``sign_status`` /
``verify_status`` look the ``SECRET`` name up in module globals at call time, so a
test may ``monkeypatch.setattr(status_token, "SECRET", ...)`` to pin a known secret
(the vitest suite pins ``MIMIC_STATUS_SECRET`` before importing for the same
reason). ``_now_ms`` is likewise a module-level indirection so tests can freeze
time deterministically — neither affordance changes the emitted wire bytes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import time
from typing import Any, Mapping, Optional

from .logger import logger

__all__ = [
    "DEV_ONLY_SECRET",
    "MAX_AGE_MS",
    "SECRET",
    "sign_status",
    "verify_status",
]

# Dev-only fallback secret. Local/test runs and ephemeral preview deploys don't
# always have MIMIC_STATUS_SECRET wired up, so we fall back to a fixed constant to
# keep the flow exercisable — but warn loudly, since tokens signed with this value
# are forgeable by anyone reading this source (statusToken.ts:11-16).
DEV_ONLY_SECRET = "tenetx-mimic-dev-only-insecure-secret"

_status_secret = os.environ.get("MIMIC_STATUS_SECRET")
if not _status_secret:
    logger.warning(
        "MIMIC_STATUS_SECRET not set. Falling back to an insecure dev-only secret; "
        "status tokens are forgeable."
    )
# JS `statusSecret || DEV_ONLY_SECRET` — empty string is falsy, so an unset OR
# blank env var both fall back to the dev secret.
SECRET = _status_secret or DEV_ONLY_SECRET

# Reject any token whose embedded iat is older than this (5 minutes).
# (statusToken.ts:25)
MAX_AGE_MS = 5 * 60 * 1000


def _now_ms() -> int:
    """Epoch milliseconds, the Python equivalent of JS ``Date.now()``. Indirected
    through a function so tests can freeze it; returns an ``int`` so ``iat``
    serializes without a decimal point (byte-identity with Node)."""
    return int(time.time() * 1000)


def _b64url_encode_nopad(data: bytes) -> str:
    """base64url with padding stripped — matches Node ``.toString('base64url')``."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    """Decode base64url, re-adding the ``=`` padding Node omits. Only ever called
    on a base64 part whose HMAC already verified, so it is always well-formed."""
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def _hmac_sha256(base64_part: str) -> bytes:
    """Raw HMAC-SHA256 digest over the base64url part, keyed by the module
    ``SECRET`` (looked up at call time so a monkeypatch takes effect)."""
    return hmac.new(
        SECRET.encode("utf-8"), base64_part.encode("utf-8"), hashlib.sha256
    ).digest()


def sign_status(payload: Mapping[str, Any]) -> str:
    """Stamp an ``iat`` (epoch ms) into the payload, then sign. Port of
    statusToken.ts:29-34.

    The caller's own fields are preserved; ``iat`` is always (re)stamped to the
    current time and appended last. Returns ``"<base64url>.<hmacSha256Hex>"``.
    """
    with_iat = {**payload, "iat": _now_ms()}
    base64_part = _b64url_encode_nopad(
        json.dumps(with_iat, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    signature = _hmac_sha256(base64_part).hex()
    return f"{base64_part}.{signature}"


def verify_status(token: Any) -> Optional[dict[str, Any]]:
    """Return the decoded payload (including ``iat``) for a well-formed, correctly
    signed, non-expired token; return ``None`` on any malformed input, signature
    mismatch, or expiry. Port of statusToken.ts:39-72 — never raises.
    """
    if not isinstance(token, str) or len(token) == 0:
        return None

    parts = token.split(".")
    if len(parts) != 2:
        return None
    base64_part, signature = parts
    if not base64_part or not signature:
        return None

    # Constant-time signature check. Compare lengths first: `compare_digest` on
    # unequal-length inputs still short-circuits, and bytes.fromhex on
    # attacker-supplied garbage (odd length / non-hex) raises — treated as a
    # mismatch, mirroring Node's short/empty Buffer.from(<bad hex>, 'hex').
    expected_sig = _hmac_sha256(base64_part)
    try:
        provided_sig = bytes.fromhex(signature)
    except ValueError:
        return None
    if len(provided_sig) != len(expected_sig):
        return None
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None

    # Signature verified above, so the payload bytes are trusted to be ours; a
    # parse failure here means genuinely corrupt input rather than tampering.
    try:
        parsed = json.loads(_b64url_decode(base64_part).decode("utf-8"))
    except Exception:
        return None
    # JS: typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    # -> anything but a plain dict is rejected (list/str/number/None all fail).
    if not isinstance(parsed, dict):
        return None

    iat = parsed.get("iat")
    # JS: typeof iat !== 'number' || !Number.isFinite(iat). `bool` is an `int`
    # subclass in Python, so exclude it explicitly (JS `typeof true` is 'boolean').
    if isinstance(iat, bool) or not isinstance(iat, (int, float)) or not math.isfinite(iat):
        return None
    if _now_ms() - iat > MAX_AGE_MS:
        return None

    return parsed
