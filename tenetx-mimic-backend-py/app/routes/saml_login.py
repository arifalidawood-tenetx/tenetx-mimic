"""GET /saml/login — UNAUTHENTICATED SP-initiated SAML login kickoff (in-process).

Port of ``tenetx-mimic-backend/src/index.ts:704-759`` (the route + its
``firstQueryValue``) and ``:338-400`` (``requestSamlLogin``).

THE CORE FIX OF THIS MIGRATION. The Node backend shelled out to
``harness/saml_login_request_harness.py`` via ``spawn(python3, ...)`` to build the
AuthnRequest, which fails in production with ``spawn python3 ENOENT`` (there is no
Python on the Coolify host). This port calls the vendored ``SAMLProvider``
DIRECTLY, in-process, inside the request handler — no subprocess, so that ENOENT
failure mode cannot exist. Confirmed live this session: the deployed Node service
returns ``502 {"error":"could not run login harness: spawn python3 ENOENT"}`` for
every real login; this route is the direct fix.

The browser hits this route at the very start of a login with no Firebase ID
token to send, so — exactly like ``/saml/acs`` — it has NO auth dependency
(index.ts:704-706 mounts it "NO authMiddleware" by design). ``sp_base_url`` is
derived from the request host/scheme via :mod:`app.request_context`, the same
helpers ``/saml/acs`` (todo 9) and the logout routes (todo 10) use.

In-process replacement of the subprocess flow (index.ts:338-400 -> here):

  * The subprocess ALWAYS resolved to a ``SamlLoginResult`` (``redirect`` |
    ``config_error``), collapsing spawn errors / 20s timeouts / nonzero exits /
    unparseable stdout into one clean ``config_error``. In-process there is no
    spawn/timeout/exit-code; the only real failure is the provider raising, which
    :func:`request_saml_login` catches and returns as ``config_error``.
  * ``requestSamlLogin(spBaseUrl, encodeRelayState(...), idpEntityId, idpSsoUrl,
    idpCert)`` passed the ENCODED RelayState as the harness ``--return-url``, which
    the harness forwarded verbatim into ``create_login_request(return_url=...)``
    (it becomes the AuthnRequest's ``RelayState``). We do the same: the
    ``return_url`` argument here is the encoded RelayState string, NOT the raw
    ``returnUrl`` query param.

ERROR-SHAPE PARITY — every failure branch returns an explicit
:class:`~fastapi.responses.JSONResponse` with an ``{"error": ...}`` body (never
FastAPI's ``HTTPException``, which renders ``{"detail": ...}`` — wrong shape).
A config error or any unexpected exception yields a clean ``502``, never a 500 /
raw traceback (index.ts:752-758).
"""
from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from app.logger import log_event, logger
from app.relay_state import encode_relay_state
from app.request_context import (
    derive_request_host,
    derive_request_scheme,
    first_query_value,
)
from app.vendored.saml_provider import SAMLConfigurationError, SAMLProvider

router = APIRouter()


def _derive_request_data(sp_base_url: str) -> tuple[dict, str, str]:
    """Build ``(request_data, normalized_sp_base_url, acs_url)`` from the SP base URL.

    In-process port of ``harness/saml_login_request_harness.py:_derive_request_data``
    (lines 127-162). ``request_data`` is the HTTP-request shape
    ``OneLogin_Saml2_Auth`` expects. For an SP-initiated login the AuthnRequest's
    ACS URL + SP entity id come from the SAML *settings* (not from ``request_data``),
    so these values only identify the SP host.

    ``sp_base_url`` here is ``scheme://host`` (no port), so ``server_port`` defaults
    per-scheme (443/80) — the harness reads an explicit ``parsed.port`` when present,
    which never happens for our host-only URL, so we must NOT hardcode 3000.

    Raises ``ValueError`` when ``sp_base_url`` is not an absolute ``scheme://host``
    URL. The harness ``sys.exit(EXIT_INPUT)``s here (which the Node subprocess then
    collapsed into a ``config_error``); in-process we raise so
    :func:`request_saml_login` maps it to the same ``config_error``.
    """
    parsed = urlparse(sp_base_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(
            f"sp_base_url '{sp_base_url}' is not an absolute URL (need scheme://host)"
        )
    is_https = parsed.scheme.lower() == "https"
    server_port = parsed.port or (443 if is_https else 80)
    normalized = f"{parsed.scheme.lower()}://{parsed.netloc}"
    acs_url = f"{normalized}/saml/acs"
    request_data = {
        "https": "on" if is_https else "off",
        "http_host": parsed.netloc,
        # This route represents the SP-initiated /saml/login endpoint. The value
        # is inert for auth.login() (which reads the ACS from settings), but set
        # honestly rather than blank (harness parity, saml_login_request_harness.py:157).
        "script_name": "/saml/login",
        "server_port": server_port,
        "get_data": {},
        "post_data": {},
    }
    return request_data, normalized, acs_url


def request_saml_login(
    sp_base_url: str,
    encoded_relay_state: str,
    idp_entity_id: str,
    idp_sso_url: str,
    idp_cert: str,
) -> dict:
    """Build the SP-initiated login redirect URL by calling the vendored
    ``SAMLProvider`` IN-PROCESS. Always returns a result dict — never raises for a
    known SAML config failure.

    In-process replacement for index.ts:338-400 ``requestSamlLogin`` (which spawned
    the login harness). Returns ``{"result": "redirect", "url": <sso url>}`` on
    success, or ``{"result": "config_error", "message": <str>}`` on a bad
    ``sp_base_url`` or any :class:`SAMLConfigurationError` from the provider
    (mirroring the harness's ``config_error`` verdict and the subprocess collapse of
    ``EXIT_INPUT`` / ``EXIT_CONFIG`` into a single ``config_error``).

    Constructs ``idp_config`` in the exact shape ``_build_idp_config`` produces for
    fully-supplied IdP metadata (harness lines 348-359), pinning ``saml_acs_url`` to
    THIS mimic's own ``/saml/acs`` route (not the product's ``/api/saml/acs``).
    """
    try:
        request_data, normalized_base, acs_url = _derive_request_data(sp_base_url)
    except ValueError as exc:
        return {"result": "config_error", "message": str(exc)}

    idp_config = {
        "provider": "keycloak",
        "saml_entity_id": idp_entity_id,
        "saml_sso_url": idp_sso_url,
        "saml_certificate": idp_cert,
        # This mimic's OWN ACS route — the Recipient the IdP POSTs the Response
        # back to (harness: acs_url = f"{normalized}/saml/acs").
        "saml_acs_url": acs_url,
    }

    try:
        provider = SAMLProvider(
            idp_config, org_slug="mimic-tryout", sp_base_url=normalized_base
        )
        sso_url = provider.create_login_request(
            request_data, return_url=encoded_relay_state
        )
    except SAMLConfigurationError as exc:
        # SAMLProvider.__init__ (missing metadata / python3-saml not installed) and
        # create_login_request (which wraps OneLogin_Saml2_Error + any Exception as
        # SAMLConfigurationError) both surface here — one clean config_error.
        return {"result": "config_error", "message": str(exc)}

    return {"result": "redirect", "url": sso_url}


@router.get("/saml/login")
async def saml_login(request: Request) -> Response:
    """GET /saml/login — port of index.ts:717-759. UNAUTHENTICATED by design.

    Validates the four required query params, derives the SP base URL from the
    request host/scheme, encodes the RelayState, then calls the vendored
    ``SAMLProvider`` in-process to build the AuthnRequest and 302-redirects the
    browser to the IdP SSO URL carrying ``SAMLRequest`` + ``RelayState``.
    """
    # index.ts:718-722 — read + trim the query params (connectionDocId optional).
    idp_entity_id = first_query_value(request.query_params.get("idpEntityId"))
    idp_sso_url = first_query_value(request.query_params.get("idpSsoUrl"))
    idp_cert = first_query_value(request.query_params.get("idpCert"))
    return_url = first_query_value(request.query_params.get("returnUrl"))
    connection_doc_id = first_query_value(request.query_params.get("connectionDocId"))

    # index.ts:724-734 — required-param validation: same order, same message shape.
    required = [
        ("idpEntityId", idp_entity_id),
        ("idpSsoUrl", idp_sso_url),
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

    # index.ts:736-737 — sp-base-url = "<scheme>://<host>", derived exactly as the
    # ACS path does (header-only, via app.request_context).
    sp_base_url = f"{derive_request_scheme(request)}://{derive_request_host(request)}"

    # index.ts:742 — encode RelayState. `connectionDocId || undefined` in JS => pass
    # None when absent/empty so encode_relay_state takes the bare-returnUrl path
    # (todo 6's JS-falsy parity); a real docId => "mimicrs:"-prefixed composite.
    encoded_relay_state = encode_relay_state(
        {"returnUrl": return_url, "connectionDocId": connection_doc_id or None}
    )

    try:
        result = request_saml_login(
            sp_base_url,
            encoded_relay_state,
            idp_entity_id,
            idp_sso_url,
            idp_cert,
        )
        # index.ts:748-751 — success: 302 to the IdP SSO URL (SAMLRequest+RelayState).
        if result.get("result") == "redirect" and result.get("url"):
            return RedirectResponse(url=result["url"], status_code=302)
        # index.ts:752-754 — config_error -> clean 502 JSON (never a raw traceback).
        return JSONResponse(
            status_code=502,
            content={"error": result.get("message") or "login request failed"},
        )
    except Exception as error:  # noqa: BLE001 — index.ts:755-758 defensive catch-all
        log_event(logger, "error", "SAML login request errored", {"err": str(error)})
        return JSONResponse(
            status_code=502, content={"error": "login request could not run"}
        )
