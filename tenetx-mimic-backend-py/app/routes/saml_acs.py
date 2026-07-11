"""POST /saml/acs — UNAUTHENTICATED SAML ACS endpoint (in-process validation).

Port of ``tenetx-mimic-backend/src/index.ts:557-702`` (the route) and ``:277-336``
(``validateCapturedResponse``), plus the request-host/scheme/script_name derivation
of ``harness/keycloak_saml_harness.py`` (``_parse_destination`` +
``_derive_request_parts`` + ``_build_idp_config``) reproduced IN-PROCESS.

THE SECURITY-CRITICAL ROUTE OF THIS MIGRATION. During a real SAML login Keycloak
POSTs a signed ``SAMLResponse`` here and cannot send a Firebase ID token, so this
route intentionally has NO auth dependency (index.ts:557-559 "NO authMiddleware").
It:

  1. Persists the raw base64 ``SAMLResponse`` to ``.captured/`` exactly as the Node
     route did (the ONLY branch allowed to 500 — a disk-write failure).
  2. Best-effort debug-logs the decoded XML with the IdP ``<X509Certificate>``
     stripped (LOG_LEVEL-gated, never fails the request).
  3. Decodes the ``RelayState`` (todo 6) and, when it carries a ``connectionDocId``,
     resolves that tester's own IdP identity from Firestore (todo 7).
  4. LIVE-VALIDATES the response through the vendored ``SAMLProvider``
     IN-PROCESS — no ``subprocess``/``spawn``, no ``keycloak_saml_harness.py``
     invocation — using request-host-derived SP settings (TEN-141 Defect A).
  5. On a decoded RelayState with an allowlisted ``returnUrl`` origin, 302-redirects
     to the SPA with a signed ``samlStatus`` token (todo 6); otherwise renders one
     of three raw-HTML bodies (validated 200 / rejected 401 / inconclusive 200).

THE CORE FIX (same as /saml/login, todo 8): the Node backend shelled out to
``harness/keycloak_saml_harness.py`` via ``spawn(python3, ...)`` to run the real
``SAMLProvider``, which cannot exist on the Coolify host (no Python) — so it was
dead in production. This port calls ``SAMLProvider.parse_and_validate_response()``
directly, in-process, so that failure mode is gone.

SECURITY — the vendored ``SAMLProvider`` is called with its own
``_build_saml_settings()`` UNCHANGED (``strict: True``, ``wantMessagesSigned:
True``, signature/audience/Destination checks). These are NEVER relaxed to make a
test pass: if strict validation correctly rejects a fixture, the fixture is wrong,
not the settings. An unsigned/synthetic response being REJECTED is the expected,
correct outcome.

ERROR-SHAPE PARITY — the ONLY 500 in this whole route is the capture-to-disk
failure (index.ts:595). Every other failure degrades gracefully: a missing
``SAMLResponse`` is a 400 JSON body; a rejected response is a 401 HTML body; a
config/inconclusive verdict is a 200 HTML body; an allowlisted RelayState is a 302
redirect. An uncaught exception anywhere in the validation/response phase falls
through to a 200 "captured" HTML body — this route NEVER 500s past the capture
step (index.ts:690-701).
"""
from __future__ import annotations

import base64
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from defusedxml.ElementTree import fromstring as _xml_fromstring
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.logger import debug_saml_xml, log_event, logger
from app.mimic_connections import MimicIdpConnection, get_mimic_idp_connection
from app.relay_state import decode_relay_state
from app.request_context import (
    derive_request_host,
    derive_request_scheme,
    escape_html,
    is_allowed_relay_state,
)
from app.status_token import sign_status
from app.vendored.public_url import normalize_public_host
from app.vendored.saml_provider import (
    SAMLConfigurationError,
    SAMLProvider,
    SAMLValidationError,
)

router = APIRouter()

# app/routes/saml_acs.py -> parent(routes)/parent(app)/parent == tenetx-mimic-backend-py/
_PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent

# Synthetic IdP metadata defaults, copied VERBATIM from
# harness/keycloak_saml_harness.py:76-103 (NOT imported — the harness is not part
# of this FastAPI service). Used only when neither a Firestore override nor the
# MIMIC_IDP_* env vars supply real Keycloak metadata; the entity_id matches the
# bundled synthetic fixture's <saml:Issuer> so IdP-issuer validation passes and the
# unsigned-message rejection is the deterministic failure. The cert is a throwaway
# self-signed TEST-ONLY cert (no matching private key), used only so python3-saml
# can build settings — it never verifies a real signature.
_DEFAULT_ENTITY_ID = "https://synthetic-keycloak-idp.invalid/realms/tenetx-mimic"
_DEFAULT_SSO_URL = (
    "https://synthetic-keycloak-idp.invalid/realms/tenetx-mimic/protocol/saml"
)
_DEFAULT_SYNTHETIC_CERT = """-----BEGIN CERTIFICATE-----
MIIDSDCCAjCgAwIBAgIUCpUWSTRfPnCiW2qxSvz8percUZIwDQYJKoZIhvcNAQEL
BQAwXTEnMCUGA1UEAwwec3ludGhldGljLWtleWNsb2FrLWlkcC5pbnZhbGlkMTIw
MAYDVQQKDClUZW5ldFggU0FNTCBIYXJuZXNzIFN5bnRoZXRpYyAoVEVTVCBPTkxZ
KTAgFw0yMDAxMDEwMDAwMDBaGA8yMDk5MDEwMTAwMDAwMFowXTEnMCUGA1UEAwwe
c3ludGhldGljLWtleWNsb2FrLWlkcC5pbnZhbGlkMTIwMAYDVQQKDClUZW5ldFgg
U0FNTCBIYXJuZXNzIFN5bnRoZXRpYyAoVEVTVCBPTkxZKTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAJljXm1eQ9Eluy2YbCGX22qzAqmHWgTeVwWda+1f
tUFUV33e3OWk8nyFwVKED+/ZXLszYt8bFaexdsQyM7ImTKUcpwHzlaP94cPBHHad
bAwWCvctEmWmRE6An7JmiVEZQcoIHVtGEwjIfmjng9BvOX7u3QEWOKM17vJuUz/C
S39HZI4hVVsE324zbXUvH0Fz5XyqueM307joHuvkDJciI5jTbM9wPl6OL0oznwpQ
Gv7u3z+iLFh0Xr8ZyBTldmebPONRm3QbmkuUmavvCfIwq7tRJ0Xydu3XE+ZY/bhw
xUw8wQAvbdQr88K0fKFdL+R82D0FzirR74XeKFIFFc6kVrcCAwEAATANBgkqhkiG
9w0BAQsFAAOCAQEAO+suSh4rqgLEj2J4XT2pI4KQ1PX58eapVJOsHc1Yy3Hfpl+H
UkAlmn42urbUQueY86Wpfo6nc+R5Mv6Iytoh+aN2sE7UYgyUod2rbj12pehOR+VW
Hc27srohQczlm3an96AWIRKNE1J92pGq1fzMLXrH8vGEKy6fe1xi8se31ENs5c7/
J9q21wIIcj3Vr2uKRaFe4QNV6R04m19xD3FluSpXNNdqRrLj0XkZSXNhp3BRZD26
LEIJ8TWaMCN8LGH+h3HsT4KGOv5oxBYVg4qJYe+PAfRugfR+RzVTJF3xM5HmlSLi
eZM6Q5Sv5RTpHeunuK3/MQ67Pp0w1fcGihlFsw==
-----END CERTIFICATE-----"""

# SECURITY: signed SAMLResponses (Keycloak/Authentik) embed the IdP's
# <ds:X509Certificate> inline, so strip it BEFORE the debug XML dump — the XML is
# not covered by logger REDACT_CONFIG and is safe to log only once cert-free
# (index.ts:608-611). ``.*?`` + DOTALL == the JS ``[\s\S]*?`` (any char incl.
# newlines); IGNORECASE == the ``i`` flag; the optional ``([\w-]+:)?`` matches an
# ``ns:`` prefix like ``ds:``.
_X509_REDACT_RE = re.compile(
    r"<([\w-]+:)?X509Certificate>.*?</([\w-]+:)?X509Certificate>",
    re.IGNORECASE | re.DOTALL,
)

# The shared "<p>SAMLResponse captured ...</p>" line every raw-HTML body appends
# (index.ts:620 ``capturedNote``).
_CAPTURED_NOTE = "<p>SAMLResponse captured to <code>.captured/</code></p>"


def _parse_destination(xml_bytes: bytes) -> str:
    """Extract the real ``Destination`` attribute from ``<samlp:Response>``.

    In-process port of ``keycloak_saml_harness.py:212-240``. Raises ``ValueError``
    (never a raw traceback) on malformed XML, a non-``Response`` root, or a missing
    ``Destination`` — the caller collapses that into an ``inconclusive`` verdict,
    mirroring the harness's clean ``EXIT_INPUT`` exit + the Node subprocess's
    inconclusive fallback.

    Uses ``defusedxml`` (not stdlib ``xml.etree``) for the parse, matching the
    XXE-safe convention todo 4 established for untrusted XML in this service; the
    extracted ``Destination`` is identical for every well-formed response.
    """
    try:
        root = _xml_fromstring(xml_bytes)
    except Exception as exc:  # noqa: BLE001 — ParseError / defused entity rejection / etc.
        raise ValueError(f"could not parse SAML Response XML: {exc}") from exc

    tag = root.tag  # e.g. "{urn:oasis:names:tc:SAML:2.0:protocol}Response"
    if not (tag.endswith("}Response") or tag == "Response"):
        raise ValueError(
            f"root element is <{tag}>, expected a <samlp:Response>"
        )

    destination = root.get("Destination")
    if not destination:
        raise ValueError(
            "<samlp:Response> has no Destination attribute, so the ACS URL / host / "
            "script_name cannot be derived"
        )
    return destination


def _derive_request_parts(
    destination: str, request_host: str, request_scheme: str
) -> dict:
    """Derive the SP identity parts (host/scheme/port/script_name/ACS) in
    REQUEST-HOST mode — always.

    In-process port of ``keycloak_saml_harness.py:243-305``, taking the
    ``if request_host:`` branch UNCONDITIONALLY. The Node route always passes
    ``--request-host``/``--request-scheme`` (index.ts:288-289) because
    :func:`app.request_context.derive_request_host` always yields a host from a real
    request, so this route never uses the harness's legacy Destination-derived mode.

    ``script_name`` still comes from the signed ``Destination``'s path (the ACS path
    the IdP signed over), but ``http_host`` / ``sp_base_url`` / port / scheme float
    with the REQUEST host — so a divergent forwarded host makes the SP ACS/Entity-ID
    stop matching the signed Destination/Recipient/Audience and ``strict: True``
    rejects it (TEN-141 Defect A, live). ``http_host`` is computed by the REAL
    product ``normalize_public_host`` (vendored), never a reimplementation.
    """
    parsed = urlparse(destination)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(
            f"Destination '{destination}' is not an absolute URL (need scheme://host/path)"
        )

    script_name = parsed.path or "/"
    scheme = (request_scheme or parsed.scheme or "https").lower()
    netloc = request_host
    is_https = scheme == "https"
    reparsed = urlparse(f"{scheme}://{netloc}")  # so .port parses out of the netloc
    http_host = normalize_public_host(netloc)
    server_port = reparsed.port or (443 if is_https else 80)
    sp_base_url = f"{scheme}://{netloc}"
    acs_url = f"{sp_base_url}{script_name}"
    return {
        "https": is_https,
        "http_host": http_host,
        "script_name": script_name,
        "server_port": server_port,
        "sp_base_url": sp_base_url,
        "acs_url": acs_url,
    }


def _build_idp_config(
    override_idp: MimicIdpConnection | None, acs_url: str
) -> dict:
    """Map the effective IdP metadata to the ``saml_*`` keys ``SAMLProvider``
    requires, honoring the precedence chain.

    In-process port of the Node override-vs-env branch
    (``validateCapturedResponse``, index.ts:293-301) FEEDING the harness's
    ``_build_idp_config`` precedence (keycloak_saml_harness.py:308-359), minus the
    CLI/``--idp-config``-file machinery (there is no config file in-process, so the
    harness's ``file_config`` layer is empty and drops out).

    Precedence, per field:
      * ``overrideIdp`` (resolved from Firestore via the RelayState ``connectionDocId``)
        — a per-tester identity; its ``certificate`` is already a full PEM, used inline.
      * else the ``MIMIC_IDP_ENTITY_ID`` / ``MIMIC_IDP_SSO_URL`` / ``MIMIC_IDP_CERT_FILE``
        env vars (``MIMIC_IDP_CERT_FILE`` is a FILE PATH — its contents are read).
      * else the synthetic ``_DEFAULT_*`` constants.

    It is an either/or between the override block and the env block (matching the
    Node ``if (overrideIdp) { ... } else { ... }``), not a per-field merge across the
    two. ``saml_acs_url`` is always the request-host-derived ``acs_url`` from
    :func:`_derive_request_parts` (never hard-coded).
    """
    if override_idp is not None:
        # index.ts:294-296 — override.entity_id is always present (getMimicIdpConnection
        # returns None otherwise); sso_url / certificate ride only when truthy.
        entity_id_arg = override_idp.get("entity_id") or None
        sso_url_arg = override_idp.get("sso_url") or None
        cert_inline = override_idp.get("certificate") or None
        cert_file = None
    else:
        # index.ts:298-300 — today's MIMIC_IDP_* env-var identity, unchanged.
        entity_id_arg = os.environ.get("MIMIC_IDP_ENTITY_ID") or None
        sso_url_arg = os.environ.get("MIMIC_IDP_SSO_URL") or None
        cert_inline = None
        cert_file = os.environ.get("MIMIC_IDP_CERT_FILE") or None

    # keycloak_saml_harness.py:334-346 — a --idp-cert-file's CONTENTS win over an
    # inline cert, and both win over the synthetic default.
    cert_from_file = None
    if cert_file:
        with open(cert_file, "r", encoding="utf-8") as handle:
            cert_from_file = handle.read()
    certificate = (cert_from_file or cert_inline) or _DEFAULT_SYNTHETIC_CERT

    return {
        "provider": "keycloak",
        "saml_entity_id": entity_id_arg or _DEFAULT_ENTITY_ID,
        "saml_sso_url": sso_url_arg or _DEFAULT_SSO_URL,
        "saml_certificate": certificate,
        # Pinned to the request-host-derived ACS — never a hard-coded guess.
        "saml_acs_url": acs_url,
    }


def validate_captured_response(
    saml_response: str,
    request_host: str,
    request_scheme: str,
    override_idp: MimicIdpConnection | None,
) -> dict:
    """Validate a captured base64 ``SAMLResponse`` against a real or overridden IdP
    identity, IN-PROCESS, and ALWAYS return a verdict dict (never raises).

    In-process replacement for index.ts:277-336 ``validateCapturedResponse`` (which
    spawned ``keycloak_saml_harness.py`` and collapsed every subprocess failure into
    one clean verdict). The verdict shapes match the harness's ``--json`` output and
    the Node ``SamlVerdict`` interface (index.ts:234-240):

      * ``{"result": "config_error", "message": <str>}`` — ``SAMLProvider`` could not
        be constructed (bad/missing IdP metadata).
      * ``{"result": "rejected", "reason": <str>}`` — ``parse_and_validate_response``
        raised ``SAMLValidationError`` (its message already embeds
        ``"... | Reason: <reason>"`` — surfaced VERBATIM, never re-wrapped).
      * ``{"result": "validated", "email": <str>, "name_id": <str>}`` — success.
      * ``{"result": "inconclusive", "message": <str>}`` — any other problem
        (unparseable XML / missing Destination / bad cert file / an unexpected
        crash), mirroring the Node subprocess's collapse of unparseable/crashed
        output. NEVER propagates past this function.

    SECURITY: ``SAMLProvider`` runs with its own strict ``_build_saml_settings()``
    unchanged (``strict: True``, ``wantMessagesSigned: True``). This function does
    NOT relax anything to reach a "validated" verdict.
    """
    # Destination extraction + SP-parts derivation + IdP-config build. Any failure
    # here (malformed XML, missing Destination, unreadable cert file) is the Node
    # subprocess's EXIT_INPUT -> inconclusive collapse.
    try:
        # UNREDACTED bytes — redaction is a logging-only concern (see the route's
        # debug block) and must not affect the Destination extraction path.
        xml_bytes = base64.b64decode(saml_response)
        destination = _parse_destination(xml_bytes)
        parts = _derive_request_parts(destination, request_host, request_scheme)
        idp_config = _build_idp_config(override_idp, parts["acs_url"])
    except Exception as exc:  # noqa: BLE001 — clean inconclusive, never a traceback
        return {"result": "inconclusive", "message": str(exc)}

    # request_data mirrors keycloak_saml_harness.py:463-470 (auth.py:828-835 shape).
    request_data = {
        "https": "on" if parts["https"] else "off",
        "http_host": parts["http_host"],
        "script_name": parts["script_name"],
        "server_port": parts["server_port"],
        "get_data": {},
        "post_data": {"SAMLResponse": saml_response},
    }

    try:
        provider = SAMLProvider(
            idp_config, org_slug="mimic-harness", sp_base_url=parts["sp_base_url"]
        )
    except SAMLConfigurationError as exc:
        return {"result": "config_error", "message": str(exc)}

    try:
        assertion = provider.parse_and_validate_response(saml_response, request_data)
    except SAMLValidationError as exc:
        # The message already embeds "... | Reason: <reason>" (saml_provider.py:249-254)
        # — surface it verbatim (TEN-141 Defect B), never re-wrap.
        return {"result": "rejected", "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 — defensive; provider wraps all failures
        # already, but the outer subprocess used to collapse anything unexpected into
        # inconclusive, so match that rather than let it escape.
        return {"result": "inconclusive", "message": str(exc)}

    return {
        "result": "validated",
        "email": assertion.email,
        "name_id": assertion.name_id,
    }


@router.post("/saml/acs")
async def saml_acs(request: Request) -> Response:
    """POST /saml/acs — port of index.ts:573-702. UNAUTHENTICATED by design.

    Reads the form-encoded ``SAMLResponse`` (required) + ``RelayState`` (optional),
    persists the raw response to ``.captured/``, live-validates it in-process, then
    either 302-redirects to an allowlisted SPA ``returnUrl`` with a signed status
    token or renders one of the three raw-HTML verdict bodies.
    """
    # index.ts:574-578 — SAMLResponse is required. form.get() yields str | UploadFile
    # | None; anything but a non-empty str is the JS ``typeof !== 'string' || !x``.
    form = await request.form()
    saml_response = form.get("SAMLResponse")
    if not isinstance(saml_response, str) or not saml_response:
        return JSONResponse(
            status_code=400, content={"error": "SAMLResponse is required"}
        )

    # index.ts:580-588 — build the capture path. new Date().toISOString() is always
    # millisecond precision + trailing 'Z'; isoformat(timespec="milliseconds") +
    # "+00:00"->"Z" reproduces that exactly. Then replace :/. with - for the filename
    # (index.ts:587 ``.replace(/[:.]/g, '-')``).
    captured_at = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    captured_dir = os.environ.get("MIMIC_CAPTURED_DIR") or os.path.join(
        _PACKAGE_ROOT, ".captured"
    )
    sanitized = captured_at.replace(":", "-").replace(".", "-")
    file_path = os.path.join(captured_dir, f"saml-response-{sanitized}.txt")

    # index.ts:590-597 — persist. This is the ONLY branch allowed to 500, and only on
    # a disk-write/mkdir failure. Every other failure below is 400/401/200/302.
    try:
        os.makedirs(captured_dir, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as handle:
            handle.write(f"# captured {captured_at} (UTC)\n{saml_response}\n")
    except Exception as exc:  # noqa: BLE001 — index.ts:593-596
        log_event(
            logger, "error", "Failed to persist captured SAMLResponse", {"err": str(exc)}
        )
        return JSONResponse(
            status_code=500, content={"error": "failed to persist SAMLResponse"}
        )

    # index.ts:599-618 — best-effort debug dump of the decoded XML (LOG_LEVEL-gated,
    # a no-op below debug). A decode failure must NOT fail a capture that already
    # succeeded on disk, so it is wrapped in its own try. The <X509Certificate> is
    # stripped first (the XML is not in REDACT_CONFIG and is safe only cert-free).
    try:
        xml_text = base64.b64decode(saml_response).decode("utf-8")
        sanitized_xml = _X509_REDACT_RE.sub(
            "<X509Certificate>[REDACTED]</X509Certificate>", xml_text
        )
        debug_saml_xml(
            logger,
            "SAMLResponse captured",
            sanitized_xml.replace("><", ">\n<"),
            file_path=file_path,
        )
    except Exception as exc:  # noqa: BLE001 — index.ts:616-617
        log_event(
            logger,
            "warn",
            "Could not base64-decode SAMLResponse for console preview",
            {"err": str(exc)},
        )

    # index.ts:621-701 — the whole validation + response phase is wrapped so this
    # route can NEVER 500 past the capture step above. Any uncaught exception falls
    # through to the 200 "captured" HTML body (index.ts:690-701).
    try:
        request_host = derive_request_host(request)
        request_scheme = derive_request_scheme(request)

        # index.ts:625-635 — decode RelayState; a connectionDocId resolves this
        # tester's own IdP identity from Firestore (plain sync call — NOT awaited,
        # NOT a FastAPI dependency), else None -> the MIMIC_IDP_* env-var identity.
        raw_relay_state = form.get("RelayState")
        decoded = (
            decode_relay_state(raw_relay_state)
            if isinstance(raw_relay_state, str) and raw_relay_state
            else None
        )
        override_idp = (
            get_mimic_idp_connection(decoded["connectionDocId"])
            if decoded and decoded.get("connectionDocId")
            else None
        )

        verdict = validate_captured_response(
            saml_response, request_host, request_scheme, override_idp
        )

        # index.ts:639-651 — OPEN-REDIRECT GUARD: 302 to the SPA only when RelayState
        # decoded non-null AND its returnUrl origin is on the allowlist. The
        # ``decoded and`` is load-bearing — no-RelayState callbacks decode to None and
        # MUST fall through to the raw-HTML bodies below.
        if decoded and is_allowed_relay_state(decoded["returnUrl"]):
            token = sign_status(
                {
                    "status": verdict["result"],
                    "email": verdict.get("email"),
                    "reason": verdict.get("reason"),
                }
            )
            return RedirectResponse(
                f'{decoded["returnUrl"]}?samlStatus={token}', status_code=302
            )

        # index.ts:653-665 — validated: 200 HTML.
        if verdict["result"] == "validated":
            who = escape_html(
                verdict.get("email")
                or verdict.get("name_id")
                or "(no email in assertion)"
            )
            return HTMLResponse(
                status_code=200,
                content=(
                    "<!doctype html><html><body><h1>Login succeeded</h1>"
                    f"<p>Validated by the real SAMLProvider. Signed-in user: <strong>{who}</strong></p>"
                    f"{_CAPTURED_NOTE}</body></html>"
                ),
            )

        # index.ts:667-679 — rejected: 401 HTML with the specific reason verbatim.
        if verdict["result"] == "rejected":
            return HTMLResponse(
                status_code=401,
                content=(
                    "<!doctype html><html><body><h1>Login rejected</h1>"
                    "<p>The real SAMLProvider rejected this response. Specific reason:</p>"
                    f"<pre>{escape_html(verdict.get('reason') or '(no reason reported)')}</pre>"
                    f"{_CAPTURED_NOTE}</body></html>"
                ),
            )

        # index.ts:681-689 — config_error / inconclusive: 200 HTML (no hard verdict).
        return HTMLResponse(
            status_code=200,
            content=(
                "<!doctype html><html><body><h1>SAMLResponse captured</h1>"
                f"<p>Live validation did not reach a verdict: {escape_html(verdict.get('message') or verdict.get('reason') or 'unknown')}</p>"
                f"{_CAPTURED_NOTE}</body></html>"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — index.ts:690-701 defensive catch-all
        log_event(logger, "error", "Live SAML validation errored", {"err": str(exc)})
        return HTMLResponse(
            status_code=200,
            content=(
                "<!doctype html><html><body><h1>SAMLResponse captured</h1>"
                "<p>Live validation could not run; the capture on disk is unaffected.</p>"
                f"{_CAPTURED_NOTE}</body></html>"
            ),
        )
