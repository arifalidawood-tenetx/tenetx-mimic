#!/usr/bin/env python3
"""TEN-141 root-cause harness: run the REAL, unmodified SAMLProvider read-only.

This harness reproduces exactly what the TenetX product does when Keycloak POSTs
a signed SAML Response to the ACS endpoint - but standalone, so we can feed it a
captured (or synthetic) response and read the real validation verdict.

It does NOT reimplement any product logic. It imports and invokes:
  - ``tenetx.auth.providers.saml.SAMLProvider`` (unmodified) to validate.
  - ``tenetx.common.public_url.normalize_public_host`` to compute ``http_host``.
Both come from ``tenetx-source-code-dontpush/`` and are treated as read-only
reference; this file never copies their source and never edits that tree.

Key behaviours (see .omo/plans/keycloak-saml-login-diff-fix.md, todo 5):
  - The ACS path is read from the response's ``<samlp:Response Destination=...>``
    attribute and used to derive ``saml_acs_url`` / ``http_host`` / ``script_name``.
    It is NEVER hard-coded - the real product's ACS path is ``/api/saml/acs`` (not
    ``/saml/acs``), so we always follow whatever the IdP actually signed over.
  - Both outcomes are handled explicitly: a raised ``SAMLValidationError`` (whose
    message already embeds ``"... | Reason: <reason>"``) is caught and printed, and
    a benign successful return (e.g. the missing-AttributeStatement warning branch
    in saml.py) prints a distinct "VALIDATED (no error)" line. We never call a
    ``provider.get_last_error_reason()`` method - it does not exist on SAMLProvider.

Dependency bootstrap: the real SAMLProvider needs ``python3-saml`` (``onelogin``).
If the launching interpreter lacks it, this harness re-execs itself once under the
product venv (``tenetx-source-code-dontpush/.venv``) so ``python keycloak_saml_harness.py``
works regardless of which interpreter started it.

Usage:
    python keycloak_saml_harness.py --fixture <path>
        [--idp-entity-id URL] [--idp-sso-url URL]
        [--idp-cert PEM | --idp-cert-file PATH] [--idp-config config.json]

The ``--fixture`` file may be either raw SAML Response XML (e.g. the bundled
synthetic fixture) or a base64 ``SAMLResponse`` string (e.g. a real capture).

Exit codes:
    0  validation reached a definitive verdict (rejected-with-Reason OR benign
       success) - the harness ran correctly.
    2  SAMLProvider could not be constructed / imported (bad IdP metadata, or the
       product package could not be imported).
    3  input error (fixture missing / empty / not base64 / malformed XML /
       Destination missing) - a clean message, never a raw traceback.
    4  python3-saml is unavailable and no product venv with it could be found.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_INPUT = 3
EXIT_NO_DEP = 4

_REEXEC_FLAG = "TENETX_SAML_HARNESS_REEXEC"
_HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
# tenetx-mimic/harness/ -> ../.. == repo root -> tenetx-source-code-dontpush/
_PRODUCT_ROOT = os.path.abspath(
    os.path.join(_HARNESS_DIR, "..", "..", "tenetx-source-code-dontpush")
)

# Default synthetic IdP metadata. These are placeholders that let SAMLProvider
# construct cleanly when validating the bundled synthetic fixture; real runs
# supply real Keycloak metadata via CLI args or --idp-config. The entity_id
# matches the synthetic fixture's <saml:Issuer> so IdP-issuer validation passes
# and the unsigned-message rejection is the deterministic failure.
_DEFAULT_ENTITY_ID = "https://synthetic-keycloak-idp.invalid/realms/tenetx-mimic"
_DEFAULT_SSO_URL = (
    "https://synthetic-keycloak-idp.invalid/realms/tenetx-mimic/protocol/saml"
)

# Throwaway self-signed cert (TEST ONLY, no matching private key committed).
# Only used so python3-saml can build settings; the synthetic fixture is
# unsigned, so this cert never actually verifies anything.
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

    The real SAMLProvider imports onelogin. If the current interpreter lacks it,
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


def _load_response(path: str) -> tuple[str, bytes]:
    """Return (saml_response_b64, response_xml_bytes) from a fixture/capture file.

    Accepts either raw SAML Response XML (starts with ``<``) or a base64
    ``SAMLResponse`` string. Exits cleanly (EXIT_INPUT) on any input problem.
    """
    if not os.path.isfile(path):
        _eprint(f"ERROR: fixture/response file not found: {path}")
        sys.exit(EXIT_INPUT)

    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        raw = handle.read().strip()

    if not raw:
        _eprint(f"ERROR: fixture/response file is empty: {path}")
        sys.exit(EXIT_INPUT)

    # Capture files (tenetx-mimic-backend/src/index.ts:204) prepend a
    # "# captured <ts> (UTC)" header line; drop "#"-comment lines ("#" is not
    # in the base64 alphabet) so the harness reads the exact captured file.
    raw = "\n".join(
        line for line in raw.splitlines() if not line.lstrip().startswith("#")
    ).strip()

    if not raw:
        _eprint(f"ERROR: fixture/response file has no content after comments: {path}")
        sys.exit(EXIT_INPUT)

    if raw.lstrip().startswith("<"):
        # Raw XML fixture: python3-saml expects base64, so encode it.
        xml_bytes = raw.encode("utf-8")
        saml_response_b64 = base64.b64encode(xml_bytes).decode("ascii")
        return saml_response_b64, xml_bytes

    # Otherwise treat as a base64 SAMLResponse (real capture shape). Strip any
    # remaining internal whitespace/newlines so validate=True (which rejects
    # them) accepts a wrapped or trailing-newline base64 body.
    raw = "".join(raw.split())
    try:
        xml_bytes = base64.b64decode(raw, validate=True)
    except (base64.binascii.Error, ValueError) as exc:
        _eprint(
            "ERROR: file content is neither well-formed XML (it does not start "
            f"with '<') nor a valid base64 SAMLResponse string: {exc}"
        )
        sys.exit(EXIT_INPUT)
    return raw, xml_bytes


def _parse_destination(xml_bytes: bytes, path: str) -> str:
    """Extract the real ``Destination`` attribute from ``<samlp:Response>``.

    Exits cleanly (EXIT_INPUT) - never a raw traceback - on malformed XML, a
    non-Response root, or a missing Destination.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        _eprint(f"ERROR: could not parse SAML Response XML from {path}: {exc}")
        sys.exit(EXIT_INPUT)

    tag = root.tag  # e.g. "{urn:oasis:names:tc:SAML:2.0:protocol}Response"
    if not (tag.endswith("}Response") or tag == "Response"):
        _eprint(
            f"ERROR: root element is <{tag}>, expected a <samlp:Response>. "
            "This does not look like a SAML Response document."
        )
        sys.exit(EXIT_INPUT)

    destination = root.get("Destination")
    if not destination:
        _eprint(
            "ERROR: <samlp:Response> has no Destination attribute, so the ACS URL / "
            "host / script_name cannot be derived. Refusing to guess an ACS path "
            "(the real product's is /api/saml/acs, but this harness never assumes)."
        )
        sys.exit(EXIT_INPUT)
    return destination


def _derive_request_parts(
    destination: str,
    normalize_public_host,
    *,
    request_host: str | None = None,
    request_scheme: str | None = None,
) -> dict:
    """Derive host/scheme/port/script_name/sp_base_url for the SP identity.

    ``http_host`` is computed with the REAL product ``normalize_public_host``
    (never a reimplementation), mirroring auth.py:824.

    Two modes:
      - Default (``request_host`` is None): every part is derived from the
        signed ``Destination`` and ``acs_url`` is pinned to it. This is the
        original root-cause-harness behaviour; by construction it can never
        exhibit the TEN-141 host divergence (see task-9 evidence).
      - Request-host mode (``request_host`` supplied): ``http_host`` /
        ``sp_base_url`` / port / scheme come from the REQUEST host instead,
        exactly as the real product builds ``sp_base_url`` from the request
        host (auth.py:_public_origin_from_request) rather than from what the
        IdP signed. ``acs_url`` (the Recipient the SP settings advertise) is
        then host-derived too, so a divergent forwarded host makes the SP
        ACS/Entity-ID stop matching the signed Destination/Recipient/Audience
        and ``strict:True`` rejects it. This is how the mimic ACS endpoint
        mirrors TEN-141's Defect A live.
    """
    parsed = urlparse(destination)
    if not parsed.scheme or not parsed.netloc:
        _eprint(
            f"ERROR: Destination '{destination}' is not an absolute URL. Need "
            "scheme://host/path to derive http_host + script_name."
        )
        sys.exit(EXIT_INPUT)

    script_name = parsed.path or "/"

    if request_host:
        # The ACS path we serve is whatever the IdP signed over (script_name),
        # but the host/scheme are the REQUEST's, so the SP identity floats with
        # the (attacker-influenceable) forwarded host — the TEN-141 divergence.
        scheme = (request_scheme or parsed.scheme or "https").lower()
        netloc = request_host
    else:
        scheme = parsed.scheme.lower()
        netloc = parsed.netloc

    is_https = scheme == "https"
    reparsed = urlparse(f"{scheme}://{netloc}")  # so .port parses in both modes
    http_host = normalize_public_host(netloc)
    server_port = reparsed.port or (443 if is_https else 80)
    sp_base_url = f"{scheme}://{netloc}"
    # Destination mode pins the Recipient to the signed Destination (legacy);
    # request-host mode host-derives it so the divergence is actually exercised.
    acs_url = f"{sp_base_url}{script_name}" if request_host else destination
    return {
        "https": is_https,
        "http_host": http_host,
        "script_name": script_name,
        "server_port": server_port,
        "sp_base_url": sp_base_url,
        "acs_url": acs_url,
    }


def _build_idp_config(args: argparse.Namespace, acs_url: str) -> dict:
    """Map mimic-shape IdP metadata to the ``saml_*`` keys SAMLProvider requires.

    Precedence: explicit CLI arg > --idp-config JSON value > synthetic default.
    ``saml_acs_url`` is pinned to the real Destination extracted from the response.
    """
    file_config: dict = {}
    if args.idp_config:
        if not os.path.isfile(args.idp_config):
            _eprint(f"ERROR: --idp-config file not found: {args.idp_config}")
            sys.exit(EXIT_INPUT)
        try:
            with open(args.idp_config, "r", encoding="utf-8") as handle:
                file_config = json.load(handle)
        except (json.JSONDecodeError, OSError) as exc:
            _eprint(f"ERROR: could not read --idp-config JSON: {exc}")
            sys.exit(EXIT_INPUT)

    def pick(cli_value, *keys, default=None):
        if cli_value:
            return cli_value
        for key in keys:
            if file_config.get(key):
                return file_config[key]
        return default

    certificate = None
    if args.idp_cert_file:
        if not os.path.isfile(args.idp_cert_file):
            _eprint(f"ERROR: --idp-cert-file not found: {args.idp_cert_file}")
            sys.exit(EXIT_INPUT)
        with open(args.idp_cert_file, "r", encoding="utf-8") as handle:
            certificate = handle.read()
    certificate = pick(
        certificate or args.idp_cert,
        "saml_certificate",
        "certificate",
        default=_DEFAULT_SYNTHETIC_CERT,
    )

    return {
        "provider": "keycloak",
        "saml_entity_id": pick(
            args.idp_entity_id, "saml_entity_id", "entity_id", default=_DEFAULT_ENTITY_ID
        ),
        "saml_sso_url": pick(
            args.idp_sso_url, "saml_sso_url", "sso_url", default=_DEFAULT_SSO_URL
        ),
        "saml_certificate": certificate,
        # Pinned to Keycloak's actual signed Destination - never a hard-coded guess.
        "saml_acs_url": acs_url,
    }


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="keycloak_saml_harness.py",
        description=(
            "Validate a captured/synthetic SAML Response with the REAL, unmodified "
            "TenetX SAMLProvider to root-cause TEN-141."
        ),
    )
    parser.add_argument(
        "--fixture",
        required=True,
        help="Path to a SAML Response file: raw XML or a base64 SAMLResponse string.",
    )
    parser.add_argument(
        "--idp-entity-id",
        help="IdP Entity ID (maps to saml_entity_id). Defaults to a synthetic value.",
    )
    parser.add_argument(
        "--idp-sso-url",
        help="IdP SSO URL (maps to saml_sso_url). Defaults to a synthetic value.",
    )
    parser.add_argument(
        "--idp-cert",
        help="IdP X.509 certificate PEM (maps to saml_certificate).",
    )
    parser.add_argument(
        "--idp-cert-file",
        help="Path to a file containing the IdP X.509 certificate PEM.",
    )
    parser.add_argument(
        "--idp-config",
        help=(
            "Path to a JSON file with keys saml_entity_id / saml_sso_url / "
            "saml_certificate (e.g. from the mimic app's /verify-metadata output)."
        ),
    )
    parser.add_argument(
        "--request-host",
        help=(
            "Request host (X-Forwarded-Host preferred, else Host) the SP identity "
            "is derived from. When set, sp_base_url/http_host/ACS come from THIS "
            "host instead of the signed Destination (mirrors TEN-141 Defect A)."
        ),
    )
    parser.add_argument(
        "--request-scheme",
        choices=["http", "https"],
        help="Request scheme for --request-host mode. Defaults to the Destination scheme.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "Emit a single-line JSON verdict on stdout (result=validated|rejected|"
            "config_error, plus email or reason) for machine callers like the "
            "mimic ACS endpoint. Diagnostics go to stderr."
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
            SAMLValidationError,
        )
        from tenetx.common.public_url import normalize_public_host  # noqa: E402
    except Exception as exc:  # pragma: no cover - environment/setup failure
        _eprint(
            f"ERROR: could not import the real SAMLProvider from {_PRODUCT_ROOT}: {exc}"
        )
        return EXIT_CONFIG

    # --json reserves stdout for the single machine verdict; diagnostics -> stderr.
    def emit_info(message: str) -> None:
        print(message, file=sys.stderr if args.json else sys.stdout)

    saml_response_b64, xml_bytes = _load_response(args.fixture)
    destination = _parse_destination(xml_bytes, args.fixture)
    parts = _derive_request_parts(
        destination,
        normalize_public_host,
        request_host=args.request_host,
        request_scheme=args.request_scheme,
    )
    idp_config = _build_idp_config(args, parts["acs_url"])

    # Mirror tenetx/api/routes/auth.py:828-835 as closely as a request-less
    # harness can. Default mode derives host/scheme/port from the signed
    # Destination; --request-host mode derives them from the request host
    # (TEN-141 Defect A) - see _derive_request_parts.
    request_data = {
        "https": "on" if parts["https"] else "off",
        "http_host": parts["http_host"],
        "script_name": parts["script_name"],
        "server_port": parts["server_port"],
        "get_data": {},
        "post_data": {"SAMLResponse": saml_response_b64},
    }

    emit_info(f"[harness] product root : {_PRODUCT_ROOT}")
    emit_info(f"[harness] Destination  : {destination}  (read from the response, not guessed)")
    emit_info(
        f"[harness] request_data : https={request_data['https']} "
        f"http_host={request_data['http_host']} script_name={request_data['script_name']} "
        f"server_port={request_data['server_port']}"
    )
    emit_info(
        f"[harness] sp_base_url  : {parts['sp_base_url']}  |  "
        f"saml_acs_url={idp_config['saml_acs_url']}"
    )

    try:
        provider = SAMLProvider(
            idp_config,
            org_slug="mimic-harness",
            sp_base_url=parts["sp_base_url"],
        )
    except SAMLConfigurationError as exc:
        if args.json:
            print(json.dumps({"result": "config_error", "message": str(exc)}))
        else:
            print(f"[harness] SAMLConfigurationError: {exc}")
        _eprint(
            "ERROR: SAMLProvider could not be constructed (missing/invalid IdP "
            f"metadata): {exc}"
        )
        return EXIT_CONFIG

    try:
        assertion = provider.parse_and_validate_response(saml_response_b64, request_data)
    except SAMLValidationError as exc:
        # The real code embeds "... | Reason: <reason>" in this message
        # (saml.py:239-244). We surface that verbatim - never call a nonexistent
        # provider.get_last_error_reason(). This is TEN-141 Defect B's fix: the
        # SPECIFIC reason reaches the caller instead of a generic code.
        if args.json:
            print(json.dumps({"result": "rejected", "reason": str(exc)}))
        else:
            print(f"[harness] SAMLValidationError: {exc}")
        return EXIT_OK
    except SAMLConfigurationError as exc:  # pragma: no cover - defensive
        if args.json:
            print(json.dumps({"result": "config_error", "message": str(exc)}))
        else:
            print(f"[harness] SAMLConfigurationError during validation: {exc}")
        return EXIT_CONFIG

    email = getattr(assertion, "email", None)
    name_id = getattr(assertion, "name_id", None)
    if args.json:
        print(json.dumps({"result": "validated", "email": email, "name_id": name_id}))
    else:
        # Benign-success branch: validation returned an assertion (e.g. the
        # missing-AttributeStatement warning path in saml.py:226-238). This is
        # NOT a crash and NOT a reproduction of the TEN-141 failure.
        print(
            f"VALIDATED (no error) - assertion.email={email} - this run did NOT "
            "reproduce the TEN-141 failure, re-check inputs"
        )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
