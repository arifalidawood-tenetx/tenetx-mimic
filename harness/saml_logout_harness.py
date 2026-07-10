#!/usr/bin/env python3
"""SAML Single Logout (SLO) harness - NEW code, built directly on python3-saml.

Unlike ``keycloak_saml_harness.py`` (which drives the read-only product
``SAMLProvider`` to VALIDATE login Responses), this module implements SLO from
scratch because the product's ``SAMLProvider`` has NO logout support at all:
``_build_saml_settings`` (tenetx-source-code-dontpush/tenetx/auth/providers/
saml.py:114-165) hard-codes ``logoutRequestSigned``/``logoutResponseSigned`` to
``False`` and there is no ``create_logout_request``/``process_slo`` companion
method anywhere in that class. So this file constructs an
``onelogin.saml2.auth.OneLogin_Saml2_Auth`` directly with its OWN settings dict
(mirroring the SHAPE of ``_build_saml_settings`` but NOT importing it) and calls
the toolkit's real ``.logout()`` / ``.process_slo()``.

It deliberately imports NOTHING from ``tenetx-source-code-dontpush/`` and never
edits that tree - only the vendored ``python3-saml`` (``onelogin``) library.

Two subcommands:

  initiate  Build the redirect URL to the IdP's SLO endpoint carrying an
            unsigned ``LogoutRequest`` (SP-initiated logout). Prints
            ``{"result":"redirect","url":"<idp-slo-url>?SAMLRequest=...&RelayState=..."}``.

  process   Given the query-string values the IdP sent back on the SP's SLS
            endpoint (a ``LogoutResponse`` - or a ``LogoutRequest`` for the
            IdP-initiated case), validate/process them with the real toolkit.
            Prints ``{"result":"logged_out"}`` on success or
            ``{"result":"error","message":"..."}`` on any failure - NEVER a raw
            traceback.

Signing convention: matches the rest of this repo - UNSIGNED requests/responses
(Keycloak/Authentik client "signature required" stays Off). Concretely the
``security`` block keeps ``logoutRequestSigned``/``logoutResponseSigned`` False
AND - the key difference from the product's login settings - sets
``wantMessagesSigned`` to False, so python3-saml ACCEPTS the unsigned
LogoutResponse instead of rejecting it. The product uses ``wantMessagesSigned:
True`` there because Google Workspace signs the login Response; SLO here is
unsigned, so validating it under ``strict: True`` requires this one flag flip.

Dependency bootstrap: identical to ``keycloak_saml_harness.py`` - if the
launching interpreter lacks ``onelogin``, re-exec once under the product venv
(``tenetx-source-code-dontpush/.venv``) which ships python3-saml.

Usage:
    python saml_logout_harness.py initiate \
        --idp-entity-id URL --idp-slo-url URL [--idp-sso-url URL] \
        [--idp-cert PEM | --idp-cert-file PATH] \
        --sp-base-url URL [--sp-sls-url URL] \
        --return-url URL [--name-id NAMEID] [--json]

    python saml_logout_harness.py process \
        [--saml-response B64] [--saml-request B64] [--relay-state STR] \
        --idp-entity-id URL --idp-slo-url URL [--idp-sso-url URL] \
        [--idp-cert PEM | --idp-cert-file PATH] \
        --sp-base-url URL [--sp-sls-url URL] [--json]

Exit codes (mirroring keycloak_saml_harness.py):
    0  the subcommand reached a definitive verdict (redirect built, logged_out,
       or a clean {"result":"error",...} for an invalid-but-processed message) -
       the harness ran correctly.
    2  the auth object could not be constructed (invalid IdP/SP metadata).
    3  input error (missing required arg / no SAML message supplied) - a clean
       message, never a raw traceback.
    4  python3-saml is unavailable and no product venv with it could be found.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from urllib.parse import urlparse

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_INPUT = 3
EXIT_NO_DEP = 4

_REEXEC_FLAG = "TENETX_SAML_LOGOUT_HARNESS_REEXEC"
_HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
# tenetx-mimic/harness/ -> ../.. == repo root -> tenetx-source-code-dontpush/
_PRODUCT_ROOT = os.path.abspath(
    os.path.join(_HARNESS_DIR, "..", "..", "tenetx-source-code-dontpush")
)

# Default synthetic IdP/SP identity. These let the auth object construct cleanly
# for a standalone self-test; real runs supply real Keycloak/Authentik metadata
# via CLI args. Naming matches harness/sign_fixture.py's synthetic IdP so the two
# helpers describe the same fictional test realm.
_DEFAULT_IDP_ENTITY_ID = "https://mimic-saml-test-idp.invalid/realms/tenetx-mimic"
_DEFAULT_IDP_SLO_URL = (
    "https://mimic-saml-test-idp.invalid/realms/tenetx-mimic/protocol/saml"
)
_DEFAULT_SP_BASE_URL = "https://mimic-sp.invalid"
_DEFAULT_RETURN_URL = "https://tenetx-mimic.web.app/mimic/try-it-out"


def _eprint(message: str) -> None:
    print(message, file=sys.stderr)


def _find_product_venv_python() -> str | None:
    """Return the product venv interpreter that has python3-saml, if present."""
    candidates = [
        os.path.join(_PRODUCT_ROOT, ".venv", "Scripts", "python.exe"),  # Windows
        os.path.join(_PRODUCT_ROOT, ".venv", "bin", "python"),  # POSIX
        os.path.join(_PRODUCT_ROOT, ".venv", "bin", "python3"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None


def _ensure_saml_dependency() -> None:
    """Guarantee python3-saml (onelogin) is importable, re-execing once if not.

    Mirrors keycloak_saml_harness.py: if the current interpreter lacks onelogin,
    re-exec this same script under the product venv (which ships it). A one-shot
    env flag prevents an infinite re-exec loop.
    """
    try:
        import onelogin  # noqa: F401  (probe only)

        return
    except ModuleNotFoundError:
        pass

    if os.environ.get(_REEXEC_FLAG) == "1":
        _eprint(
            "ERROR: python3-saml (onelogin) is unavailable even after switching to "
            "the product venv. Install it (pip install python3-saml) to run the "
            "SAML SLO harness."
        )
        sys.exit(EXIT_NO_DEP)

    venv_python = _find_product_venv_python()
    if venv_python is None:
        _eprint(
            "ERROR: python3-saml (onelogin) is not installed in this interpreter, "
            f"and no product venv was found under {os.path.join(_PRODUCT_ROOT, '.venv')}. "
            "Run this harness with an interpreter that has python3-saml installed."
        )
        sys.exit(EXIT_NO_DEP)

    child_env = dict(os.environ)
    child_env[_REEXEC_FLAG] = "1"
    completed = subprocess.run(
        [venv_python, os.path.abspath(__file__), *sys.argv[1:]],
        env=child_env,
    )
    sys.exit(completed.returncode)


def _normalize_cert(cert: str | None) -> str:
    """Strip PEM headers/whitespace so python3-saml accepts a bare base64 body.

    Re-implemented here (NOT imported from the product's SAMLProvider) to keep
    this module fully isolated from tenetx-source-code-dontpush/. Returns "" for
    an absent cert - valid here because unsigned SLO needs no IdP cert (settings
    only require one when wantMessagesSigned/wantAssertionsSigned are True).
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


def _resolve_cert(args: argparse.Namespace) -> str | None:
    """Read the IdP cert from --idp-cert-file or --idp-cert (file wins)."""
    if args.idp_cert_file:
        if not os.path.isfile(args.idp_cert_file):
            _eprint(f"ERROR: --idp-cert-file not found: {args.idp_cert_file}")
            sys.exit(EXIT_INPUT)
        with open(args.idp_cert_file, "r", encoding="utf-8") as handle:
            return handle.read()
    return args.idp_cert


def _sp_sls_url(args: argparse.Namespace) -> str:
    """The SP SLS endpoint the IdP posts the LogoutResponse back to."""
    if args.sp_sls_url:
        return args.sp_sls_url
    return f"{args.sp_base_url.rstrip('/')}/api/saml/sls"


def _build_settings(args: argparse.Namespace, idp_cert: str | None) -> dict:
    """Build the python3-saml settings dict for SLO.

    Mirrors the STRUCTURE of SAMLProvider._build_saml_settings (saml.py:114-165)
    - same sp/idp/security key layout - but is written from scratch (never
    imported) and differs in three deliberate ways:
      * sp.singleLogoutService.url  <- --sp-sls-url (product hard-codes it)
      * idp.singleLogoutService.url <- --idp-slo-url (product leaves it "")
      * security.wantMessagesSigned <- False (product uses True for signed login
        Responses; SLO here is unsigned, so this must be False or strict
        validation rejects the unsigned LogoutRequest/LogoutResponse).

    python3-saml's settings check requires a valid idp.singleSignOnService.url
    even for a pure-SLO flow (settings.py:380), so --idp-sso-url defaults to
    --idp-slo-url when unset (Keycloak serves both from the same endpoint).
    """
    sp_base_url = args.sp_base_url.rstrip("/")
    idp_slo_url = args.idp_slo_url
    idp_sso_url = args.idp_sso_url or idp_slo_url
    return {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": args.sp_entity_id or f"{sp_base_url}/saml/metadata",
            "assertionConsumerService": {
                "url": f"{sp_base_url}/api/saml/acs",
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "singleLogoutService": {
                "url": _sp_sls_url(args),
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
            "x509cert": "",
            "privateKey": "",
        },
        "idp": {
            "entityId": args.idp_entity_id,
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
            # UNSIGNED SLO (repo convention). MUST stay False - see _build_settings
            # docstring: the product uses True here for signed login Responses.
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
    """Build the OneLogin request_data whose "current URL" is the SP SLS endpoint.

    process_slo validates that the LogoutResponse's Destination starts with
    get_self_url_no_query(request_data) = "<scheme>://<http_host><script_name>"
    (utils.py:306). Deriving http_host/script_name from the SP SLS URL makes that
    current URL equal the SLS URL, so a LogoutResponse addressed to the SLS
    endpoint passes the Destination check. server_port is intentionally omitted
    (it is deprecated and emits a warning); any port lives inside http_host.
    """
    parsed = urlparse(sp_sls_url)
    return {
        "https": "on" if parsed.scheme == "https" else "off",
        "http_host": parsed.netloc,
        "script_name": parsed.path or "/",
        "get_data": get_data or {},
        "post_data": {},
    }


def _run_initiate(args, auth_cls, saml_error_cls, emit_info) -> int:
    """Build the SP-initiated LogoutRequest redirect URL to the IdP SLO endpoint."""
    settings = _build_settings(args, _resolve_cert(args))
    request_data = _sp_request_data(_sp_sls_url(args), get_data={})

    emit_info(
        f"[harness] mode=initiate idp_slo_url={settings['idp']['singleLogoutService']['url']}"
    )
    emit_info(
        f"[harness] sp_entity_id={settings['sp']['entityId']} "
        f"sp_sls_url={settings['sp']['singleLogoutService']['url']} "
        f"return_url={args.return_url} name_id={args.name_id}"
    )

    try:
        auth = auth_cls(request_data, settings)
    except Exception as exc:  # OneLogin_Saml2_Error on invalid settings
        print(json.dumps({"result": "config_error", "message": str(exc)}))
        _eprint(f"ERROR: could not build SAML auth object (invalid settings): {exc}")
        return EXIT_CONFIG

    try:
        url = auth.logout(return_to=args.return_url, name_id=args.name_id)
    except saml_error_cls as exc:
        # e.g. the IdP has no SLO endpoint configured (SAML_SINGLE_LOGOUT_NOT_SUPPORTED).
        print(json.dumps({"result": "error", "message": str(exc)}))
        _eprint(f"ERROR: logout() failed: {exc}")
        return EXIT_OK
    except Exception as exc:  # never a raw traceback on stdout
        print(json.dumps({"result": "error", "message": f"unexpected: {exc}"}))
        _eprint(f"ERROR: unexpected error building LogoutRequest: {exc}")
        return EXIT_OK

    print(json.dumps({"result": "redirect", "url": url}))
    return EXIT_OK


def _run_process(args, auth_cls, saml_error_cls, emit_info) -> int:
    """Validate/process the IdP's LogoutResponse (or LogoutRequest) via process_slo."""
    settings = _build_settings(args, _resolve_cert(args))
    sp_sls_url = _sp_sls_url(args)

    get_data: dict = {}
    if args.saml_response:
        get_data["SAMLResponse"] = args.saml_response
    if args.saml_request:
        get_data["SAMLRequest"] = args.saml_request
    if args.relay_state:
        get_data["RelayState"] = args.relay_state

    if "SAMLResponse" not in get_data and "SAMLRequest" not in get_data:
        print(
            json.dumps(
                {
                    "result": "error",
                    "message": "no SAMLResponse or SAMLRequest query value provided",
                }
            )
        )
        _eprint("ERROR: process requires --saml-response or --saml-request")
        return EXIT_INPUT

    request_data = _sp_request_data(sp_sls_url, get_data=get_data)

    emit_info(
        f"[harness] mode=process sp_sls_url={sp_sls_url} "
        "(the LogoutResponse Destination must start with this)"
    )
    emit_info(f"[harness] get_data keys={sorted(get_data.keys())}")

    try:
        auth = auth_cls(request_data, settings)
    except Exception as exc:
        print(json.dumps({"result": "config_error", "message": str(exc)}))
        _eprint(f"ERROR: could not build SAML auth object (invalid settings): {exc}")
        return EXIT_CONFIG

    try:
        slo_return = auth.process_slo(keep_local_session=True)
    except saml_error_cls as exc:
        print(json.dumps({"result": "error", "message": str(exc)}))
        _eprint(f"ERROR: process_slo raised: {exc}")
        return EXIT_OK
    except Exception as exc:
        # Malformed base64 / un-inflatable / un-parseable input lands here. NEVER
        # let the raw traceback reach stdout - emit the clean error JSON shape.
        print(
            json.dumps(
                {"result": "error", "message": f"malformed SAML logout message: {exc}"}
            )
        )
        _eprint(f"ERROR: unexpected error in process_slo: {exc}")
        return EXIT_OK

    errors = auth.get_errors()
    if errors:
        reason = auth.get_last_error_reason() or ""
        message = ", ".join(errors)
        if reason:
            message += f" | Reason: {reason}"
        print(json.dumps({"result": "error", "message": message}))
        _eprint(f"[harness] process_slo rejected the message: {message}")
        return EXIT_OK

    result = {"result": "logged_out"}
    if slo_return:
        # IdP-initiated (SAMLRequest) path: the toolkit built a LogoutResponse for
        # us to send back - surface its redirect URL for the caller.
        result["slo_response_url"] = slo_return
    print(json.dumps(result))
    return EXIT_OK


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--idp-entity-id",
        default=_DEFAULT_IDP_ENTITY_ID,
        help="IdP Entity ID (idp.entityId). Defaults to a synthetic value.",
    )
    parser.add_argument(
        "--idp-slo-url",
        default=_DEFAULT_IDP_SLO_URL,
        help="IdP Single Logout Service URL (idp.singleLogoutService.url).",
    )
    parser.add_argument(
        "--idp-sso-url",
        default=None,
        help=(
            "IdP SSO URL. python3-saml requires a valid idp.singleSignOnService.url "
            "to build settings even for a pure-SLO flow; defaults to --idp-slo-url "
            "when unset (Keycloak serves both from the same endpoint)."
        ),
    )
    parser.add_argument(
        "--idp-cert",
        default=None,
        help="IdP X.509 certificate PEM. Optional for unsigned SLO.",
    )
    parser.add_argument(
        "--idp-cert-file",
        default=None,
        help="Path to a file with the IdP X.509 certificate PEM.",
    )
    parser.add_argument(
        "--sp-entity-id",
        default=None,
        help="SP Entity ID (sp.entityId). Defaults to <sp-base-url>/saml/metadata.",
    )
    parser.add_argument(
        "--sp-base-url",
        default=_DEFAULT_SP_BASE_URL,
        help="SP base URL. sp.entityId/ACS/SLS are derived from it unless overridden.",
    )
    parser.add_argument(
        "--sp-sls-url",
        default=None,
        help=(
            "SP Single Logout Service URL the IdP posts the LogoutResponse back to. "
            "Defaults to <sp-base-url>/api/saml/sls."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "Keep stdout to the single JSON result line and route [harness] "
            "diagnostics to stderr (for machine callers like the /saml/logout and "
            "/saml/sls backend routes)."
        ),
    )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="saml_logout_harness.py",
        description=(
            "Real SAML Single Logout (SLO) via vendored python3-saml: build a "
            "LogoutRequest (initiate) or process an IdP LogoutResponse (process). "
            "New, isolated code - never imports the read-only product SAMLProvider."
        ),
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    p_init = sub.add_parser(
        "initiate",
        help="Build the redirect URL to the IdP SLO endpoint (SP-initiated logout).",
    )
    _add_common_args(p_init)
    p_init.add_argument(
        "--return-url",
        default=_DEFAULT_RETURN_URL,
        help="RelayState: where the IdP should send the user after logout.",
    )
    p_init.add_argument(
        "--name-id",
        default=None,
        help=(
            "NameID to place in the LogoutRequest (usually the logged-in user's "
            "email). When omitted, python3-saml uses the IdP entity NameID."
        ),
    )

    p_proc = sub.add_parser(
        "process",
        help="Validate/process the IdP's LogoutResponse (or LogoutRequest).",
    )
    _add_common_args(p_proc)
    p_proc.add_argument(
        "--saml-response",
        default=None,
        help="The SAMLResponse query value the IdP sent to the SLS endpoint.",
    )
    p_proc.add_argument(
        "--saml-request",
        default=None,
        help="The SAMLRequest query value (IdP-initiated logout).",
    )
    p_proc.add_argument(
        "--relay-state",
        default=None,
        help="The RelayState query value echoed back by the IdP.",
    )

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Ensure python3-saml is importable (re-exec under the product venv if not).
    _ensure_saml_dependency()

    try:
        from onelogin.saml2.auth import OneLogin_Saml2_Auth  # noqa: E402
        from onelogin.saml2.utils import OneLogin_Saml2_Error  # noqa: E402
    except Exception as exc:  # pragma: no cover - environment/setup failure
        _eprint(f"ERROR: could not import python3-saml (onelogin): {exc}")
        return EXIT_NO_DEP

    # --json reserves stdout for the single machine result; diagnostics -> stderr.
    def emit_info(message: str) -> None:
        print(message, file=sys.stderr if args.json else sys.stdout)

    if args.mode == "initiate":
        return _run_initiate(args, OneLogin_Saml2_Auth, OneLogin_Saml2_Error, emit_info)
    if args.mode == "process":
        return _run_process(args, OneLogin_Saml2_Auth, OneLogin_Saml2_Error, emit_info)

    _eprint(f"ERROR: unknown mode {args.mode!r}")
    return EXIT_INPUT


if __name__ == "__main__":
    sys.exit(main())
