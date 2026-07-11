"""POST /verify-metadata — fetch + parse a real IdP SAML descriptor server-side.

Port of two Node sources into one FastAPI module:

  * ``tenetx-mimic-backend/src/samlMetadata.ts`` — ``parseSamlMetadata`` +
    ``isAllowedMetadataHost`` + ``ALLOWED_METADATA_HOSTS``. Reproduced here as
    :func:`parse_saml_metadata` / :func:`is_allowed_metadata_host`, producing the
    IDENTICAL ``{entity_id, sso_url, slo_url, certificate}`` output shape for the
    same input XML.
  * ``tenetx-mimic-backend/src/index.ts:141-189`` — the ``POST /verify-metadata``
    route + its 400/403/422/502 error-status mapping. Reproduced as the
    :func:`verify_metadata` handler below.

XML PARSER CHOICE — ``defusedxml`` instead of raw ``lxml`` / ``xml.etree``:
The Node original uses ``fast-xml-parser``, which does not resolve external
entities, so it has no XXE exposure. A stdlib Python XML parser DOES resolve
entities by default, so swapping in ``defusedxml`` is a parser-choice SAFETY
EQUIVALENT — it closes that XXE hole and nothing else. It is NOT new validation
behavior and NOT a stricter/looser output contract: for every well-formed,
non-malicious descriptor the extracted fields are byte-for-byte what the Node
parser produces (verified against the Keycloak + Authentik fixtures).

AUTH — the route is gated by the Firebase dependency from todo 5
(``require_tenetx_user``), applied via ``Depends`` exactly as documented in
``app/auth.py``. This is the ONLY route that carries that gate; the four
``/saml/*`` routes stay unauthenticated by design (see ``app/auth.py`` +
index.ts:557/704/761/827).

ERROR-SHAPE PARITY — the Node backend returns ``{"error": ...}`` bodies via
Express ``res.status(...).json(...)``. FastAPI's ``HTTPException`` would render
``{"detail": ...}`` (wrong shape), so every failure branch returns an explicit
:class:`~fastapi.responses.JSONResponse` (Starlette serializes it compact,
``separators=(",", ":")``, byte-identical to ``res.json``). Auth rejections are
rendered by ``app/auth.py``'s registered ``AuthError`` handler, same shape.
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import urlsplit
from xml.etree.ElementTree import Element

import httpx
from defusedxml.ElementTree import fromstring as defused_fromstring
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.auth import AuthenticatedUser, require_tenetx_user
from app.logger import log_event, logger

router = APIRouter()

# SSRF host allowlist — verbatim from samlMetadata.ts:10-13. Only these two IdP
# hosts may be fetched server-side; every other host is rejected (403) BEFORE any
# network I/O happens (see the ordering in :func:`verify_metadata`).
ALLOWED_METADATA_HOSTS = frozenset(
    {
        "keycloak.arifalidawood.com",
        "authentik.arifalidawood.com",
    }
)

# Fetch timeout. The Node `fetch` (index.ts:169) sets no explicit timeout; a
# bounded value here prevents a hung IdP endpoint from hanging the request — a
# timeout collapses to the same 502 "failed to fetch metadata" a network error
# does, so it is not an observable contract change on the tested paths.
_FETCH_TIMEOUT_SECONDS = 10.0


def is_allowed_metadata_host(hostname: str) -> bool:
    """Port of ``isAllowedMetadataHost`` (samlMetadata.ts:15-17): exact membership."""
    return hostname in ALLOWED_METADATA_HOSTS


def _local_name(tag: object) -> str:
    """Strip a Clark-notation ``{namespace}`` prefix, leaving the local element name.

    ElementTree stores namespaced tags as ``{uri}Local``; the Node parser used
    ``removeNSPrefix: true`` to strip the ``md:`` / ``ds:`` prefixes Keycloak and
    Authentik emit, so lookups match by local name only. This is the Python
    equivalent. Non-``str`` tags (ElementTree comment/PI nodes carry a callable
    tag) collapse to ``""`` so they never match a wanted element name.
    """
    if isinstance(tag, str):
        return tag.rsplit("}", 1)[1] if "}" in tag else tag
    return ""


def _find_all(root: Element, local_name: str) -> list[Element]:
    """All elements whose local name equals ``local_name``, in document order.

    Equivalent to samlMetadata.ts's ``findAll`` recursive tree walk: ``root.iter()``
    is a pre-order DFS that includes ``root`` itself, so an ``EntityDescriptor``
    root element is found just like a nested one.
    """
    return [el for el in root.iter() if _local_name(el.tag) == local_name]


def parse_saml_metadata(xml: str) -> Optional[dict[str, str]]:
    """Port of ``parseSamlMetadata`` (samlMetadata.ts:47-93).

    Returns ``{entity_id, sso_url, slo_url, certificate}`` (all ``str``) or ``None``
    — identical shape and identical field-selection rules to the Node original:

      * ``entity_id``  — first ``EntityDescriptor``'s ``entityID`` attribute (``""`` if absent).
      * ``sso_url``    — first ``SingleSignOnService`` whose ``Binding`` contains
        ``HTTP-POST`` or ``HTTP-Redirect`` (document order; first supported wins).
      * ``slo_url``    — ``SingleLogoutService`` preferring ``HTTP-Redirect`` over
        ``HTTP-POST`` by binding (not document order), ``""`` when none present.
      * ``certificate``— first ``X509Certificate`` text, PEM-wrapped, ``""`` if absent.

    ``None`` when: input is empty/whitespace; the XML fails to parse (mirrors the
    Node ``try/catch { return null }`` around ``parser.parse``, and additionally
    covers defusedxml's XXE rejections); or none of entity_id/sso_url/certificate
    were found (samlMetadata.ts:90).
    """
    if not xml or not xml.strip():
        return None

    try:
        root = defused_fromstring(xml)
    except Exception:  # noqa: BLE001 — parity with samlMetadata.ts:53 `catch { return null }`
        # A malformed document OR a defusedxml XXE rejection both mean "not usable
        # metadata" → None (the route turns None into a clean 422, never a 500).
        return None

    descriptors = _find_all(root, "EntityDescriptor")
    entity_id = descriptors[0].get("entityID", "") if descriptors else ""

    # SSO: first service supporting HTTP-POST or HTTP-Redirect wins (index/doc order).
    sso_url = ""
    for svc in _find_all(root, "SingleSignOnService"):
        binding = svc.get("Binding", "")
        if "HTTP-POST" in binding or "HTTP-Redirect" in binding:
            sso_url = svc.get("Location", "")
            if sso_url:
                break

    # SLO: prefer HTTP-Redirect (SAML SLO's standard binding) over HTTP-POST by
    # binding, not document order — unlike the SSO scan above.
    slo_url = ""
    slo_services = _find_all(root, "SingleLogoutService")
    for preferred_binding in ("HTTP-Redirect", "HTTP-POST"):
        for svc in slo_services:
            binding = svc.get("Binding", "")
            if preferred_binding in binding:
                slo_url = svc.get("Location", "")
                if slo_url:
                    break
        if slo_url:
            break

    cert_nodes = _find_all(root, "X509Certificate")
    raw_cert = (cert_nodes[0].text or "").strip() if cert_nodes else ""
    certificate = (
        f"-----BEGIN CERTIFICATE-----\n{raw_cert}\n-----END CERTIFICATE-----"
        if raw_cert
        else ""
    )

    if not entity_id and not sso_url and not certificate:
        return None

    return {
        "entity_id": entity_id,
        "sso_url": sso_url,
        "slo_url": slo_url,
        "certificate": certificate,
    }


@router.post("/verify-metadata")
async def verify_metadata(
    request: Request,
    user: AuthenticatedUser = Depends(require_tenetx_user),
) -> JSONResponse:
    """POST /verify-metadata — port of index.ts:141-189.

    Behind :func:`require_tenetx_user` (Firebase auth). Reads ``{metadataUrl}``,
    SSRF-guards the host BEFORE any fetch, fetches + parses the descriptor, and
    returns ``{entity_id, sso_url, slo_url, certificate}``. Error-status mapping
    matches the Node backend exactly: 400 (missing/invalid metadataUrl), 403
    (non-allowlisted host), 502 (fetch failure), 422 (parse failure).
    """
    # index.ts:147 — `const { metadataUrl } = req.body ?? {}`. Read the JSON body
    # leniently: a malformed/absent/non-object body degrades to {} (like `?? {}`),
    # so metadataUrl reads as missing and falls into the 400 branch below.
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — no/!JSON body → treat as {} (Node's `?? {}`)
        body = None
    if not isinstance(body, dict):
        body = {}
    metadata_url = body.get("metadataUrl")

    # index.ts:148-151 — metadataUrl must be a non-empty string.
    if not isinstance(metadata_url, str) or not metadata_url:
        return JSONResponse(status_code=400, content={"error": "metadataUrl is required"})

    # index.ts:153-159 — `new URL(metadataUrl)` validates + extracts the hostname;
    # it throws on an invalid URL. urlsplit is lenient, so validate explicitly.
    # Accessing `.port` forces the same ValueError `new URL()` raises on a
    # malformed authority (e.g. a non-numeric port / bad IPv6 literal).
    try:
        parsed = urlsplit(metadata_url)
        _ = parsed.port  # raises ValueError on an invalid port (parity w/ new URL())
    except ValueError:
        return JSONResponse(
            status_code=400, content={"error": "metadataUrl is not a valid URL"}
        )

    # A usable absolute URL needs a scheme AND a host (a relative/garbage string
    # like "not a url" has an empty scheme → `new URL()` would throw → 400).
    hostname = parsed.hostname
    if not parsed.scheme or not hostname:
        return JSONResponse(
            status_code=400, content={"error": "metadataUrl is not a valid URL"}
        )

    # index.ts:161-165 — SSRF GUARD: the host allowlist is checked BEFORE any fetch
    # happens. Do NOT reorder this below the fetch. `.hostname` is already
    # lowercased by urlsplit, matching `new URL().hostname`.
    if not is_allowed_metadata_host(hostname):
        return JSONResponse(
            status_code=403, content={"error": f"host not allowlisted: {hostname}"}
        )

    # index.ts:167-179 — fetch (allowlist already passed). `follow_redirects=True`
    # matches Node `fetch`'s default redirect: 'follow'.
    try:
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT_SECONDS, follow_redirects=True
        ) as client:
            response = await client.get(metadata_url)
    except Exception as error:  # noqa: BLE001 — network/timeout → 502 (index.ts:175-178)
        log_event(logger, "error", "Metadata fetch failed", {"err": str(error)})
        return JSONResponse(status_code=502, content={"error": "failed to fetch metadata"})

    # index.ts:170-173 — `!response.ok` (any non-2xx) → 502 with the status code.
    if not response.is_success:
        return JSONResponse(
            status_code=502,
            content={"error": f"metadata fetch failed: {response.status_code}"},
        )

    xml = response.text

    # index.ts:181-185 — parse; None → 422.
    result = parse_saml_metadata(xml)
    if result is None:
        return JSONResponse(
            status_code=422, content={"error": "failed to parse SAML metadata"}
        )

    # index.ts:187 — success.
    return JSONResponse(status_code=200, content=result)
