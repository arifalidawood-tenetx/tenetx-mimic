#!/usr/bin/env python3
"""SP-initiated SAML login-request generator (reuses the REAL SAMLProvider).

This harness is the login-side companion to ``keycloak_saml_harness.py`` (which
validates the Response the IdP POSTs back). Given IdP metadata (entity id, SSO
URL, certificate), an SP base URL, and a return URL, it produces the redirect
URL the browser must be sent to in order to start a real Keycloak/Authentik
login that will eventually POST back to this mimic's own ``/saml/acs`` endpoint.

Like its sibling, it does NOT reimplement any product logic. It imports and
invokes ``tenetx.auth.providers.saml.SAMLProvider.create_login_request``
(unmodified) - which itself delegates to ``OneLogin_Saml2_Auth.login()`` to
build the deflated+base64 ``SAMLRequest`` and set ``RelayState`` to the return
URL. The AuthnRequest is UNSIGNED (``authnRequestsSigned`` is already ``False``
in the product's ``_build_saml_settings``); this harness never signs it.

It also reuses ``keycloak_saml_harness.py``'s ``_build_idp_config`` and its
synthetic-default IdP constants rather than copying either - the two scripts are
siblings in ``harness/``, so this file adds that directory to ``sys.path`` and
imports from the module (mirroring how the sibling adds ``_PRODUCT_ROOT``).
``tenetx-source-code-dontpush/`` is treated as a read-only reference: this file
never copies its source and never edits that tree.

Dependency bootstrap: the real SAMLProvider needs ``python3-saml`` (``onelogin``).
If the launching interpreter lacks it, this harness re-execs ITSELF once under
the product venv (``tenetx-source-code-dontpush/.venv``). We cannot reuse the
sibling's ``_ensure_saml_dependency`` for this because it re-execs its own
``__file__`` (keycloak_saml_harness.py); the re-exec target must be THIS script.

Usage:
    python saml_login_request_harness.py
        --sp-base-url https://mimic-sp.invalid
        --return-url "https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out"
        [--idp-entity-id URL] [--idp-sso-url URL]
        [--idp-cert PEM | --idp-cert-file PATH] [--idp-config config.json] [--json]

JSON contract (for machine callers like the mimic's /saml/login route, todo 6):
    success     -> {"result": "redirect", "url": "<sso url with SAMLRequest+RelayState>"}
    config error -> {"result": "config_error", "message": "..."}
Diagnostics always go to stderr in --json mode (stdout carries only the verdict).

Exit codes:
    0  a redirect URL was generated (EXIT_OK).
    2  SAMLProvider could not be constructed/invoked, or the product package
       could not be imported (EXIT_CONFIG) - emits result=config_error in --json.
    3  input error (e.g. --sp-base-url is not an absolute URL) (EXIT_INPUT).
    4  python3-saml is unavailable and no product venv with it could be found
       (EXIT_NO_DEP).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from urllib.parse import urlparse

# The IdP-config builder, synthetic default constants, exit codes, product root,
# and the venv finder all live in the sibling harness. Add this directory to
# sys.path so the sibling module resolves, then import them (never re-copied).
_HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
if _HARNESS_DIR not in sys.path:
    sys.path.insert(0, _HARNESS_DIR)

from keycloak_saml_harness import (  # noqa: E402  (import after sys.path setup)
    EXIT_CONFIG,
    EXIT_INPUT,
    EXIT_NO_DEP,
    EXIT_OK,
    _DEFAULT_ENTITY_ID,
    _DEFAULT_SSO_URL,
    _DEFAULT_SYNTHETIC_CERT,
    _PRODUCT_ROOT,
    _build_idp_config,
    _eprint,
    _find_product_venv_python,
)

# Distinct from the sibling's flag so the two harnesses never disturb each
# other's one-shot re-exec guard even if one ever launches the other.
_REEXEC_FLAG = "TENETX_SAML_LOGIN_HARNESS_REEXEC"


def _ensure_saml_dependency() -> None:
    """Guarantee python3-saml (onelogin) is importable, re-execing once if not.

    Mirrors ``keycloak_saml_harness._ensure_saml_dependency`` but re-execs THIS
    script (its ``__file__``), reusing the sibling's ``_find_product_venv_python``
    so the venv-discovery logic is not duplicated. A one-shot env flag prevents
    an infinite re-exec loop.
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
            "real SAMLProvider."
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


def _derive_request_data(sp_base_url: str) -> tuple[dict, str, str]:
    """Build (request_data, sp_base_url, acs_url) from the SP base URL.

    ``request_data`` is the HTTP-request shape ``OneLogin_Saml2_Auth`` expects
    (https/http_host/script_name/get_data, plus server_port/post_data for
    completeness). For an SP-initiated login the AuthnRequest's ACS URL and SP
    entity id come from the SAML *settings* (not from request_data), so these
    values only identify the SP host; they are derived straight from
    --sp-base-url. ``acs_url`` is this mimic's own ACS endpoint (/saml/acs) - the
    Recipient the IdP will POST the Response back to.
    """
    parsed = urlparse(sp_base_url)
    if not parsed.scheme or not parsed.netloc:
        _eprint(
            f"ERROR: --sp-base-url '{sp_base_url}' is not an absolute URL. Need "
            "scheme://host[:port] (e.g. https://mimic-sp.invalid)."
        )
        sys.exit(EXIT_INPUT)

    is_https = parsed.scheme.lower() == "https"
    server_port = parsed.port or (443 if is_https else 80)
    normalized = f"{parsed.scheme.lower()}://{parsed.netloc}"
    acs_url = f"{normalized}/saml/acs"

    request_data = {
        "https": "on" if is_https else "off",
        "http_host": parsed.netloc,
        # This harness represents the SP-initiated /saml/login endpoint; the
        # value is inert for auth.login() (which reads the ACS from settings),
        # but we set it honestly rather than leaving it blank.
        "script_name": "/saml/login",
        "server_port": server_port,
        "get_data": {},
        "post_data": {},
    }
    return request_data, normalized, acs_url


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="saml_login_request_harness.py",
        description=(
            "Generate an SP-initiated SAML login redirect URL using the REAL, "
            "unmodified TenetX SAMLProvider.create_login_request."
        ),
    )
    parser.add_argument(
        "--sp-base-url",
        required=True,
        help=(
            "SP base URL (scheme://host[:port]) this mimic is reachable at. "
            "Derives http_host and the /saml/acs Recipient the IdP posts back to."
        ),
    )
    parser.add_argument(
        "--return-url",
        required=True,
        help=(
            "URL to return to after login; passed through to create_login_request "
            "and surfaced verbatim as the RelayState query parameter."
        ),
    )
    parser.add_argument(
        "--idp-entity-id",
        help=(
            "IdP Entity ID (maps to saml_entity_id). Defaults to a synthetic "
            f"value ({_DEFAULT_ENTITY_ID})."
        ),
    )
    parser.add_argument(
        "--idp-sso-url",
        help=(
            "IdP SSO URL (maps to saml_sso_url); the browser is redirected here. "
            f"Defaults to a synthetic value ({_DEFAULT_SSO_URL})."
        ),
    )
    parser.add_argument(
        "--idp-cert",
        help=(
            "IdP X.509 certificate PEM (maps to saml_certificate). Defaults to a "
            f"synthetic {len(_DEFAULT_SYNTHETIC_CERT.splitlines())}-line TEST-ONLY cert."
        ),
    )
    parser.add_argument(
        "--idp-cert-file",
        help="Path to a file containing the IdP X.509 certificate PEM.",
    )
    parser.add_argument(
        "--idp-config",
        help=(
            "Path to a JSON file with keys saml_entity_id / saml_sso_url / "
            "saml_certificate (same shape keycloak_saml_harness.py accepts)."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "Emit a single-line JSON verdict on stdout (result=redirect|config_error) "
            "for machine callers like the mimic /saml/login route. Diagnostics -> stderr."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # Ensure python3-saml is importable (re-exec under the product venv if not).
    _ensure_saml_dependency()

    # Read-only import of the REAL product code (never copied, never edited).
    if _PRODUCT_ROOT not in sys.path:
        sys.path.insert(0, _PRODUCT_ROOT)
    try:
        from tenetx.auth.providers.saml import (  # noqa: E402
            SAMLConfigurationError,
            SAMLProvider,
        )
    except Exception as exc:  # pragma: no cover - environment/setup failure
        _eprint(
            f"ERROR: could not import the real SAMLProvider from {_PRODUCT_ROOT}: {exc}"
        )
        return EXIT_CONFIG

    # --json reserves stdout for the single machine verdict; diagnostics -> stderr.
    def emit_info(message: str) -> None:
        print(message, file=sys.stderr if args.json else sys.stdout)

    request_data, sp_base_url, acs_url = _derive_request_data(args.sp_base_url)
    idp_config = _build_idp_config(args, acs_url)

    using_defaults = (
        idp_config["saml_entity_id"] == _DEFAULT_ENTITY_ID
        and idp_config["saml_sso_url"] == _DEFAULT_SSO_URL
        and idp_config["saml_certificate"] == _DEFAULT_SYNTHETIC_CERT
    )

    emit_info(f"[harness] product root : {_PRODUCT_ROOT}")
    emit_info(
        f"[harness] idp sso url  : {idp_config['saml_sso_url']}  "
        "(browser is redirected here)"
    )
    emit_info(
        f"[harness] sp_base_url  : {sp_base_url}  |  saml_acs_url={acs_url}"
    )
    emit_info(
        f"[harness] request_data : https={request_data['https']} "
        f"http_host={request_data['http_host']} script_name={request_data['script_name']} "
        f"server_port={request_data['server_port']}"
    )
    emit_info(f"[harness] return_url   : {args.return_url}  (becomes RelayState)")
    emit_info(f"[harness] synthetic default IdP metadata in use: {using_defaults}")

    try:
        provider = SAMLProvider(
            idp_config,
            org_slug="mimic-tryout",
            sp_base_url=sp_base_url,
        )
        sso_url = provider.create_login_request(request_data, return_url=args.return_url)
    except SAMLConfigurationError as exc:
        if args.json:
            print(json.dumps({"result": "config_error", "message": str(exc)}))
        else:
            print(f"[harness] SAMLConfigurationError: {exc}")
        _eprint(
            "ERROR: SAMLProvider could not generate the login request (missing/invalid "
            f"IdP metadata or SAML settings): {exc}"
        )
        return EXIT_CONFIG

    if args.json:
        print(json.dumps({"result": "redirect", "url": sso_url}))
    else:
        print(sso_url)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
