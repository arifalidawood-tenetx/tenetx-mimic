"""GET /saml/logout + GET /saml/sls — UNAUTHENTICATED SAML Single Logout (in-process).

Port of ``tenetx-mimic-backend/src/index.ts:761-906`` (both routes) and
``:407-526`` (``requestSamlLogout`` / ``processSamlLogout``), plus the SLO
settings/request-data logic of ``harness/saml_logout_harness.py`` reproduced
IN-PROCESS (``_normalize_cert``/``_build_settings``/``_sp_request_data`` +
``_run_initiate``/``_run_process``).

THE CORE FIX (same as /saml/login todo 8 and /saml/acs todo 9): the Node backend
shelled out to ``harness/saml_logout_harness.py`` via ``spawn(python3, ...)`` to run
the real python3-saml toolkit, which cannot exist on the Coolify host (no Python) —
so it was dead in production. This port calls ``OneLogin_Saml2_Auth.logout()`` /
``.process_slo()`` directly, in-process, so that failure mode is gone.

WHY NOT ``SAMLProvider``: the vendored ``SAMLProvider`` has NO logout method — it
only exposes ``parse_and_validate_response``/``create_login_request``/``get_sso_url``/
``generate_metadata_xml`` — and its ``_build_saml_settings()`` hard-codes
``wantMessagesSigned: True`` (correct for signed login Responses, WRONG for the
unsigned SLO this repo uses). So we construct a fresh ``OneLogin_Saml2_Auth`` with a
standalone settings dict mirroring the SHAPE of ``_build_saml_settings()`` but with
three deliberate deviations (see :func:`_build_settings`), then call the toolkit's
standard public API directly. This is direct use of the underlying library
``SAMLProvider`` already depends on, not a reimplementation of it.

Both routes are UNAUTHENTICATED by design: the browser hits ``/saml/logout``
mid-flow and the IdP redirects the browser to ``/saml/sls`` with the LogoutResponse
— neither carries a Firebase ID token, so — exactly like ``/saml/login`` and
``/saml/acs`` — they have NO auth dependency (index.ts:761-765 / :811-826 mount them
"NO authMiddleware").

ERROR-SHAPE PARITY:
  * ``/saml/logout`` returns ONLY 400 (missing param), 302 (redirect to IdP SLO), or
    502 ``{"error": ...}`` (any construction/logout failure) — NEVER a 500 / raw
    traceback (index.ts:800-808).
  * ``/saml/sls`` returns ONLY 302 (allowlisted RelayState) or 200 HTML — it NEVER
    returns a non-200/302 status. Unlike ``/saml/acs`` there is NO 401 branch here:
    a failed/unconfirmed logout still renders a 200 "Logout not completed" body
    (index.ts:885-905). Any construction/parse failure collapses to a clean ``error``
    result, never a traceback.
"""
from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.logger import log_event, logger
from app.mimic_connections import get_mimic_idp_connection
from app.relay_state import decode_relay_state, encode_relay_state
from app.request_context import (
    derive_request_host,
    derive_request_scheme,
    escape_html,
    first_query_value,
    is_allowed_relay_state,
)
from app.status_token import sign_status

# Direct use of the vendored python3-saml toolkit (the same ``onelogin`` package
# ``SAMLProvider`` depends on), per saml_logout_harness.py:515-516. Guarded exactly
# like app/vendored/saml_provider.py:30-36 so this module still imports on an
# interpreter WITHOUT python3-saml (the hermes-agent venv used for unit tests):
# ``OneLogin_Saml2_Auth`` becomes ``None`` and the real-provider tests skip. Unlike
# the vendored provider (which sets the error to ``None``), a FALLBACK exception
# CLASS is defined so the ``except OneLogin_Saml2_Error`` clauses below stay valid —
# a mocked test patches ``OneLogin_Saml2_Auth`` and its fake ``.logout()`` /
# ``.process_slo()`` raises, at which point Python evaluates that ``except`` type
# (a ``None`` there would raise ``TypeError: catching classes that do not inherit
# from BaseException``).
try:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth
    from onelogin.saml2.utils import OneLogin_Saml2_Error
except ModuleNotFoundError:  # pragma: no cover - optional dependency (hermes venv)
    OneLogin_Saml2_Auth = None

    class OneLogin_Saml2_Error(Exception):
        """Fallback so ``except OneLogin_Saml2_Error`` stays valid when python3-saml
        is absent. The real class is imported above when ``onelogin`` is installed."""

router = APIRouter()


def _normalize_cert(cert: str | None) -> str:
    """Strip PEM headers/whitespace so python3-saml accepts a bare base64 body.

    In-process port of ``saml_logout_harness.py:157-174``. A SEPARATE function from
    ``SAMLProvider._normalize_certificate`` (an instance method, not statically
    reusable) and kept isolated from the product tree. Returns ``""`` for an
    absent/empty cert — valid for unsigned SLO, which needs no IdP cert (settings
    only require one when ``wantMessagesSigned``/``wantAssertionsSigned`` are True,
    and both are False here).
    """
    if not cert:
        return ""
    for header in (
        "-----BEGIN CERTIFICATE-----",
        "-----END CERTIFICATE-----",
        "-----BEGIN RSA CERTIFICATE-----",
        "-----END RSA CERTIFICATE-----",
    ):
        cert = cert.replace(header, "")
    return cert.replace("\n", "").replace("\r", "").replace(" ", "")


def _build_settings(
    sp_base_url: str,
    sp_sls_url: str,
    idp_entity_id: str,
    idp_slo_url: str,
    idp_cert: str,
) -> dict:
    """Build the python3-saml settings dict for SLO.

    In-process port of ``saml_logout_harness.py:195-259`` (dropping only the
    ``argparse.Namespace`` indirection). Mirrors the STRUCTURE of
    ``SAMLProvider._build_saml_settings()`` (saml_provider.py:124-175) — same
    sp/idp/security key layout — but built from scratch (never imported) with three
    deliberate deviations:

      * ``sp.singleLogoutService.url``  = this route's OWN ``/saml/sls`` URL
        (``sp_sls_url``), not the product's hard-coded ``{sp_base_url}/api/saml/sls``.
      * ``idp.singleLogoutService.url`` = ``idp_slo_url`` (the product leaves it ``""``).
      * ``security.wantMessagesSigned`` = ``False`` (the product uses ``True`` for the
        signed login Response; SLO here is unsigned, so this MUST stay ``False`` or
        strict validation rejects the unsigned LogoutRequest/LogoutResponse).

    python3-saml's settings validator requires a valid ``idp.singleSignOnService.url``
    even for a pure-SLO flow (Keycloak serves both SSO and SLO from the same
    endpoint), so it is pinned to ``idp_slo_url`` ALWAYS — NEITHER route reads a
    separate ``idpSsoUrl`` query param (index.ts:766-772 / :837-839), so there is no
    fallback chain to port.

    ``sp.entityId`` / ``sp.assertionConsumerService.url`` carry the harness's exact
    literal paths (``/saml/metadata`` and ``/api/saml/acs``); both are required by the
    settings validator but NEVER read during ``.logout()``/``.process_slo()``, so
    their values are inert — ported faithfully to match the harness's proven-working
    settings shape rather than "fixed". The rest of the ``security`` block is
    IDENTICAL to the product's (only ``wantMessagesSigned`` differs).
    """
    normalized_base = sp_base_url.rstrip("/")
    # A valid idp.singleSignOnService.url is required even for pure SLO (Keycloak
    # serves SSO + SLO from one endpoint); neither route takes a separate SSO param.
    idp_sso_url = idp_slo_url
    return {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": f"{normalized_base}/saml/metadata",
            "assertionConsumerService": {
                "url": f"{normalized_base}/api/saml/acs",
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "singleLogoutService": {
                "url": sp_sls_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
            "x509cert": "",
            "privateKey": "",
        },
        "idp": {
            "entityId": idp_entity_id,
            "singleSignOnService": {
                "url": idp_sso_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "singleLogoutService": {
                "url": idp_slo_url,
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": _normalize_cert(idp_cert),
        },
        "security": {
            "nameIdEncrypted": False,
            "authnRequestsSigned": False,
            "logoutRequestSigned": False,
            "logoutResponseSigned": False,
            "signMetadata": False,
            # UNSIGNED SLO (repo convention). MUST stay False — the product uses True
            # here for the signed login Response; strict validation would otherwise
            # reject the unsigned LogoutRequest/LogoutResponse (harness:249-251).
            "wantMessagesSigned": False,
            "wantAssertionsSigned": False,
            "wantAssertionsEncrypted": False,
            "wantNameIdEncrypted": False,
            "requestedAuthnContext": True,
            "signatureAlgorithm": "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
            "digestAlgorithm": "http://www.w3.org/2001/04/xmlenc#sha256",
        },
    }


def _sp_request_data(sp_sls_url: str, get_data: dict) -> dict:
    """Build the ``OneLogin_Saml2_Auth`` request_data whose "current URL" is the SP
    SLS endpoint. In-process port of ``saml_logout_harness.py:262-279``.

    ``process_slo`` validates that the LogoutResponse's ``Destination`` starts with
    ``get_self_url_no_query(request_data)`` = ``"<scheme>://<http_host><script_name>"``,
    so deriving ``http_host``/``script_name`` from the SP SLS URL makes that current
    URL equal the SLS URL and a LogoutResponse addressed to it passes the Destination
    check.

    CRITICAL DIVERGENCE from ``/saml/login`` (todo 8) and ``/saml/acs`` (todo 9): NO
    ``server_port`` key. It is deprecated in python3-saml (emits a warning) and any
    port already lives inside ``http_host`` (harness:269-270). Do NOT add it back —
    that is a deliberate divergence, not an oversight.
    """
    parsed = urlparse(sp_sls_url)
    return {
        "https": "on" if parsed.scheme == "https" else "off",
        "http_host": parsed.netloc,
        "script_name": parsed.path or "/",
        "get_data": get_data or {},
        "post_data": {},
    }


def request_saml_logout(
    sp_base_url: str,
    sp_sls_url: str,
    encoded_relay_state: str,
    idp_entity_id: str,
    idp_slo_url: str,
    idp_cert: str,
    name_id: str,
) -> dict:
    """Build the SP-initiated ``LogoutRequest`` redirect URL to the IdP SLO endpoint,
    IN-PROCESS via ``OneLogin_Saml2_Auth.logout()``. Always returns a result dict.

    In-process port of ``saml_logout_harness.py:282-316`` (``_run_initiate``) and the
    Node ``requestSamlLogout`` (index.ts:407-466). Returns
    ``{"result": "redirect", "url": <idp slo url with SAMLRequest+RelayState>}`` on
    success, ``{"result": "config_error", "message": <str>}`` when the auth object
    cannot be constructed (invalid settings), or ``{"result": "error", "message":
    <str>}`` when ``.logout()`` itself fails.

    ``return_to`` is the ENCODED RelayState string (same pattern as todo 8's
    ``create_login_request(return_url=encoded_relay_state)``) — NOT the raw
    ``returnUrl`` query param. It becomes the LogoutRequest's ``RelayState`` the IdP
    echoes back to ``/saml/sls``.
    """
    settings = _build_settings(
        sp_base_url, sp_sls_url, idp_entity_id, idp_slo_url, idp_cert
    )
    request_data = _sp_request_data(sp_sls_url, get_data={})

    try:
        auth = OneLogin_Saml2_Auth(request_data, settings)
    except Exception as exc:  # noqa: BLE001 — OneLogin_Saml2_Error on invalid settings
        return {"result": "config_error", "message": str(exc)}

    try:
        url = auth.logout(return_to=encoded_relay_state, name_id=name_id or None)
    except OneLogin_Saml2_Error as exc:
        # e.g. the IdP has no SLO endpoint configured (SAML_SINGLE_LOGOUT_NOT_SUPPORTED).
        return {"result": "error", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 — never a raw traceback
        return {"result": "error", "message": f"unexpected: {exc}"}

    return {"result": "redirect", "url": url}


def process_saml_logout(
    sp_base_url: str,
    sp_sls_url: str,
    idp_entity_id: str,
    idp_slo_url: str,
    idp_cert: str,
    saml_response: str,
    saml_request: str,
    relay_state: str,
) -> dict:
    """Validate/process the IdP's ``LogoutResponse`` (or ``LogoutRequest`` for the
    IdP-initiated case) IN-PROCESS via ``OneLogin_Saml2_Auth.process_slo()``. Always
    returns a result dict.

    In-process port of ``saml_logout_harness.py:319-392`` (``_run_process``) and the
    Node ``processSamlLogout`` (index.ts:473-526). Result shapes:
      * ``{"result": "error", "message": "no SAMLResponse or SAMLRequest ..."}`` —
        neither message was supplied (a clean input-error result, NOT an HTTP 400;
        the route still renders its normal 200-HTML fallback for it).
      * ``{"result": "config_error", "message": <str>}`` — auth object could not be
        constructed.
      * ``{"result": "error", "message": <str>}`` — ``process_slo`` raised, or
        ``get_errors()`` reported a rejection (message embeds ``"... | Reason: ..."``).
      * ``{"result": "logged_out"[, "slo_response_url": <url>]}`` — success. The
        ``slo_response_url`` rides only when the toolkit built a LogoutResponse for us
        to send back (IdP-initiated ``SAMLRequest`` path), for parity with the Node
        ``SamlLogoutResult`` shape.

    A raw traceback NEVER escapes: the ``process_slo`` call is wrapped, and the route
    additionally wraps the whole call so any unanticipated exception collapses to a
    clean ``error`` result (index.ts:868-871).
    """
    get_data: dict = {}
    if saml_response:
        get_data["SAMLResponse"] = saml_response
    if saml_request:
        get_data["SAMLRequest"] = saml_request
    if relay_state:
        get_data["RelayState"] = relay_state

    if "SAMLResponse" not in get_data and "SAMLRequest" not in get_data:
        return {
            "result": "error",
            "message": "no SAMLResponse or SAMLRequest query value provided",
        }

    request_data = _sp_request_data(sp_sls_url, get_data)
    settings = _build_settings(
        sp_base_url, sp_sls_url, idp_entity_id, idp_slo_url, idp_cert
    )

    try:
        auth = OneLogin_Saml2_Auth(request_data, settings)
    except Exception as exc:  # noqa: BLE001 — OneLogin_Saml2_Error on invalid settings
        return {"result": "config_error", "message": str(exc)}

    try:
        slo_return = auth.process_slo(keep_local_session=True)
    except OneLogin_Saml2_Error as exc:
        return {"result": "error", "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 — malformed base64 / un-inflatable input
        return {"result": "error", "message": f"malformed SAML logout message: {exc}"}

    errors = auth.get_errors()
    if errors:
        reason = auth.get_last_error_reason() or ""
        message = ", ".join(errors)
        if reason:
            message += f" | Reason: {reason}"
        return {"result": "error", "message": message}

    result: dict = {"result": "logged_out"}
    if slo_return:
        # IdP-initiated (SAMLRequest) path: the toolkit built a LogoutResponse for us
        # to send back — surface its redirect URL (harness:386-391).
        result["slo_response_url"] = slo_return
    return result


@router.get("/saml/logout")
async def saml_logout(request: Request) -> Response:
    """GET /saml/logout — port of index.ts:766-809. UNAUTHENTICATED by design.

    Validates the four required query params, derives the SP base/SLS URLs from the
    request host/scheme, encodes the RelayState, then calls ``OneLogin_Saml2_Auth``
    in-process to build the ``LogoutRequest`` and 302-redirects the browser to the
    IdP SLO endpoint carrying ``SAMLRequest`` + ``RelayState``.
    """
    # index.ts:767-772 — read + trim the query params (nameId/connectionDocId optional).
    idp_slo_url = first_query_value(request.query_params.get("idpSloUrl"))
    idp_entity_id = first_query_value(request.query_params.get("idpEntityId"))
    idp_cert = first_query_value(request.query_params.get("idpCert"))
    return_url = first_query_value(request.query_params.get("returnUrl"))
    name_id = first_query_value(request.query_params.get("nameId"))
    connection_doc_id = first_query_value(request.query_params.get("connectionDocId"))

    # index.ts:774-784 — required-param validation: same order, same message shape.
    required = [
        ("idpSloUrl", idp_slo_url),
        ("idpEntityId", idp_entity_id),
        ("idpCert", idp_cert),
        ("returnUrl", return_url),
    ]
    missing = [name for name, value in required if not value]
    if missing:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"missing required query param(s): {', '.join(missing)}"
            },
        )

    # index.ts:786-787 — sp-base-url = "<scheme>://<host>", sp-sls-url its /saml/sls.
    sp_base_url = f"{derive_request_scheme(request)}://{derive_request_host(request)}"
    sp_sls_url = f"{sp_base_url}/saml/sls"

    # index.ts:793 — the ENCODED RelayState is passed as logout()'s return_to (todo 6);
    # `connectionDocId || undefined` => pass None when absent so encode_relay_state
    # takes the bare-returnUrl path.
    encoded_relay_state = encode_relay_state(
        {"returnUrl": return_url, "connectionDocId": connection_doc_id or None}
    )

    try:
        result = request_saml_logout(
            sp_base_url,
            sp_sls_url,
            encoded_relay_state,
            idp_entity_id,
            idp_slo_url,
            idp_cert,
            name_id,
        )
        # index.ts:800-802 — success: 302 to the IdP SLO URL (SAMLRequest+RelayState).
        if result.get("result") == "redirect" and result.get("url"):
            return RedirectResponse(url=result["url"], status_code=302)
        # index.ts:804 — config_error / error -> clean 502 JSON (never a raw traceback).
        return JSONResponse(
            status_code=502,
            content={"error": result.get("message") or "logout request failed"},
        )
    except Exception as error:  # noqa: BLE001 — index.ts:805-808 defensive catch-all
        log_event(logger, "error", "SAML logout request errored", {"err": str(error)})
        return JSONResponse(
            status_code=502, content={"error": "logout request could not run"}
        )


@router.get("/saml/sls")
async def saml_sls(request: Request) -> Response:
    """GET /saml/sls — port of index.ts:827-906. UNAUTHENTICATED by design.

    Processes the IdP's ``LogoutResponse``/``LogoutRequest`` in-process, then either
    302-redirects a signed ``samlLogoutStatus`` token back into the SPA (when the
    RelayState decodes to an allowlisted ``returnUrl``) or renders a 200-HTML
    confirmation. This route NEVER returns a non-200/302 status.
    """
    # index.ts:828-831 — read query values (GET route, query string only — NOT form).
    saml_response = first_query_value(request.query_params.get("SAMLResponse"))
    saml_request = first_query_value(request.query_params.get("SAMLRequest"))
    relay_state = first_query_value(request.query_params.get("RelayState"))
    decoded = decode_relay_state(relay_state) if relay_state else None

    # index.ts:837-852 — per-tester identity resolution. Direct query params win; the
    # Firestore lookup fires ONLY when all three are absent AND a connectionDocId rode
    # in on the RelayState (plain sync call — NOT awaited, NOT a FastAPI dependency).
    idp_entity_id = first_query_value(request.query_params.get("idpEntityId"))
    idp_slo_url = first_query_value(request.query_params.get("idpSloUrl"))
    idp_cert = first_query_value(request.query_params.get("idpCert"))
    if (
        not idp_entity_id
        and not idp_slo_url
        and not idp_cert
        and decoded
        and decoded.get("connectionDocId")
    ):
        resolved = get_mimic_idp_connection(decoded["connectionDocId"])
        if resolved is not None:
            idp_entity_id = resolved["entity_id"]
            idp_slo_url = resolved["slo_url"]
            idp_cert = resolved["certificate"]

    # index.ts:854 — the settings builder needs sp_base_url for sp.entityId /
    # sp.assertionConsumerService.url (inert during process_slo but required by the
    # settings validator); derive it the same way /saml/logout does.
    sp_base_url = f"{derive_request_scheme(request)}://{derive_request_host(request)}"
    sp_sls_url = f"{sp_base_url}/saml/sls"

    # index.ts:856-871 — the outer catch is the last-resort net: process_saml_logout
    # returns clean dicts for anticipated failures, and anything unexpected (e.g. an
    # exception from get_errors()) collapses here rather than propagating.
    try:
        result = process_saml_logout(
            sp_base_url,
            sp_sls_url,
            idp_entity_id,
            idp_slo_url,
            idp_cert,
            saml_response,
            saml_request,
            relay_state,
        )
    except Exception as error:  # noqa: BLE001 — index.ts:868-871
        log_event(
            logger, "error", "SAML logout processing errored", {"err": str(error)}
        )
        result = {"result": "error", "message": "logout processing could not run"}

    # index.ts:873-883 — OPEN-REDIRECT GUARD: the `decoded and` is load-bearing — a
    # no-RelayState callback decodes to None and MUST fall through to the raw-HTML
    # branch, not index into decoded["returnUrl"]. NOTE the samlLogoutStatus token
    # shape (status logged_out|error), distinct from /saml/acs's samlStatus token.
    if decoded and is_allowed_relay_state(decoded["returnUrl"]):
        token = (
            sign_status({"status": "logged_out"})
            if result["result"] == "logged_out"
            else sign_status(
                {"status": "error", "message": result.get("message") or "logout failed"}
            )
        )
        return RedirectResponse(
            f'{decoded["returnUrl"]}?samlLogoutStatus={token}', status_code=302
        )

    # index.ts:886-896 — no usable RelayState + logged_out: 200 HTML confirmation.
    if result["result"] == "logged_out":
        return HTMLResponse(
            status_code=200,
            content=(
                "<!doctype html><html><body><h1>Logged out</h1>"
                "<p>The real python3-saml toolkit processed the SAML Single Logout response.</p>"
                "</body></html>"
            ),
        )

    # index.ts:898-905 — anything else: 200 HTML with the specific reason (escaped).
    return HTMLResponse(
        status_code=200,
        content=(
            "<!doctype html><html><body><h1>Logout not completed</h1>"
            f"<p>The SAML logout could not be confirmed: {escape_html(result.get('message') or 'unknown error')}</p>"
            "</body></html>"
        ),
    )
