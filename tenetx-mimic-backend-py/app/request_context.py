"""Shared request-context helpers for the ``/saml/*`` routes.

Ported from ``tenetx-mimic-backend/src/index.ts``:
  * ``firstQueryValue``  (index.ts:711-715) -> :func:`first_query_value`
  * ``firstHeaderValue`` (index.ts:215-218) -> :func:`first_header_value`
  * ``deriveRequestHost``   (index.ts:220-226) -> :func:`derive_request_host`
  * ``deriveRequestScheme`` (index.ts:228-232) -> :func:`derive_request_scheme`

Extracted into a standalone module because the SP base URL (``scheme://host``)
and query-param trimming are needed IDENTICALLY by ``/saml/login`` (todo 8),
``/saml/acs`` (todo 9), and ``/saml/logout`` + ``/saml/sls`` (todo 10). A single
source of truth keeps all four routes deriving the SP identity byte-identically,
so the SP ACS/Entity-ID the vendored ``SAMLProvider`` validates against never
drifts between the login kickoff and the ACS callback.

Todo 9 ADDS two more shared helpers here (additive — the four above are unchanged):
  * ``isAllowedRelayState`` (index.ts:536-549) -> :func:`is_allowed_relay_state`
  * ``escapeHtml``          (index.ts:528-534) -> :func:`escape_html`
Both are the open-redirect guard + HTML-escaper the ``/saml/acs`` (todo 9) and
``/saml/sls`` (todo 10) raw-HTML fallback branches share, kept here so the two
routes never drift.

These are deliberate NODE-PARITY ports, not Starlette idioms:

  * :func:`derive_request_scheme` defaults to ``'http'`` and only flips to
    ``'https'`` when the ``X-Forwarded-Proto`` header's first value says so. It
    does NOT read ``request.url.scheme`` — a TLS-terminated local test server may
    report ``'https'`` there while the Node backend, seeing no
    ``X-Forwarded-Proto``, derives ``'http'``. Follow the header-only logic so the
    Python service matches the Node service exactly (index.ts:228-232 reads only
    ``req.headers['x-forwarded-proto']``, never a connection-level scheme).
  * :func:`first_header_value` splits a raw header on ``','`` and takes the first
    value trimmed, mirroring how Express hands back a comma-joined
    ``X-Forwarded-*`` proxy chain. Starlette's ``request.headers.get(name)``
    returns that same raw comma-joined string (or ``None``), so the split matches.
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

from fastapi import Request

__all__ = [
    "first_query_value",
    "first_header_value",
    "derive_request_host",
    "derive_request_scheme",
    "is_allowed_relay_state",
    "escape_html",
]


def first_query_value(value: str | None) -> str:
    """Trim a single query-param value; ``None`` -> ``''``.

    Port of index.ts:711-715 ``firstQueryValue``. FastAPI/Starlette
    ``request.query_params.get(name)`` already returns the FIRST value for a
    repeated key (matching the JS ``Array.isArray(value) ? value[0]`` branch), so
    this helper only needs the ``None`` -> ``''`` guard and the ``.trim()``.
    """
    return (value or "").strip()


def first_header_value(value: str | None) -> str:
    """First comma-separated header value, trimmed; ``None`` -> ``''``.

    Port of index.ts:215-218 ``firstHeaderValue``. A proxy chain like
    ``X-Forwarded-Host: public.example, internal`` is handed back by Starlette as
    the raw ``"public.example, internal"`` string, so split on ``','`` and take
    ``[0].strip()`` — exactly what the Node code does with Express's comma-joined
    header value.
    """
    if not value:
        return ""
    return value.split(",")[0].strip()


def derive_request_host(request: Request) -> str:
    """Prefer ``X-Forwarded-Host`` (first value), else the ``Host`` header.

    Port of index.ts:220-226 ``deriveRequestHost``. JS ``a || b`` treats ``''``
    as falsy, so an empty/absent ``X-Forwarded-Host`` falls back to ``Host``;
    Python ``or`` is the exact equivalent.
    """
    return first_header_value(
        request.headers.get("x-forwarded-host")
    ) or first_header_value(request.headers.get("host"))


def derive_request_scheme(request: Request) -> str:
    """``'https'`` iff ``X-Forwarded-Proto``'s first value (lowercased) is
    ``'https'``, else ``'http'``.

    Port of index.ts:228-232 ``deriveRequestScheme``. The default is ``'http'``
    and is header-driven ONLY — it deliberately does NOT consult
    ``request.url.scheme`` (see the module docstring for why this parity trap
    matters for local TLS-terminated tests).
    """
    return (
        "https"
        if first_header_value(request.headers.get("x-forwarded-proto")).lower()
        == "https"
        else "http"
    )


def is_allowed_relay_state(url: str) -> bool:
    """Open-redirect guard shared by ``/saml/acs`` (todo 9) and ``/saml/sls``
    (todo 10). Port of index.ts:536-549 ``isAllowedRelayState``.

    A decoded RelayState ``returnUrl`` is only a safe 302 target when it parses to
    an absolute URL AND its origin (``scheme://netloc``) matches the
    ``ALLOWED_ORIGIN`` allowlist. Returns ``True`` when the redirect is safe,
    ``False`` when the caller must fall through to its raw-HTML branch rather than
    redirect to an untrusted origin. SECURITY — do not weaken.

    Parity notes:
      * Node uses ``new URL(url).origin``, which THROWS on a relative/invalid URL
        (caught -> ``null`` -> falsy). ``urllib.parse.urlsplit`` never throws but
        returns empty ``scheme``/``netloc`` for such input, so its computed origin
        (``"://"``) can never equal a real allowlisted origin — same net effect,
        without a try/except.
      * ``ALLOWED_ORIGIN`` is read FRESH on every call (not cached at import) so a
        test can ``monkeypatch.setenv`` it; a running process still reads the single
        value from its environment. This differs cosmetically from Node's
        module-level ``allowedOrigin`` constant but is behaviorally identical for
        the deployed service and keeps the guard unit-testable.
    """
    parsed = urlsplit(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return origin == os.environ.get("ALLOWED_ORIGIN", "https://tenetx-mimic.web.app")


def escape_html(value: str) -> str:
    """HTML-escape a string for the ``/saml/acs`` (todo 9) and ``/saml/sls``
    (todo 10) raw-HTML fallback bodies. Port of index.ts:528-534 ``escapeHtml``.

    Replaces ``&`` FIRST (so the ``&`` introduced by the later entity replacements
    is not itself re-escaped), then ``<``, ``>``, ``"`` — the exact order and set
    the Node original uses.
    """
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
