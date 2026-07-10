#!/usr/bin/env python3
"""Generate a synthetic, unsigned SAML LogoutResponse fixture for SLO testing.

TEST-ONLY. Sibling to ``sign_fixture.py`` (which builds signed login Response
fixtures). SLO in this repo is UNSIGNED by convention (Keycloak/Authentik client
"signature required" stays Off), so this helper deliberately does NOT sign - it
just hand-builds a schema-valid ``<samlp:LogoutResponse>`` and deflate+base64
encodes it exactly the way a real IdP sends it over the HTTP-Redirect binding
(``OneLogin_Saml2_Utils.deflate_and_base64_encode`` - the same primitive
python3-saml inflates on the other side).

The emitted ``saml_response`` value is what you feed
``saml_logout_harness.py process --saml-response <value>``. For that harness's
``process`` to validate it under ``strict: True`` the fixture must be
self-consistent with the harness settings:
  * ``<saml:Issuer>`` == the harness ``--idp-entity-id``.
  * ``Destination`` == the harness ``--sp-sls-url`` (so it matches the SP's
    ``get_self_url_no_query``).
  * ``<samlp:StatusCode Value>`` == the SAML Success status.
This script prints all three back so a caller can pass matching flags.

Like ``sign_fixture.py`` this is a fixture GENERATOR, not product logic: it
validates nothing and shares no code with the real SAMLProvider. It imports only
the vendored ``onelogin`` toolkit and is meant to run under the product venv.

Usage:
    python make_logout_fixture.py \
        --idp-entity-id https://idp.invalid/realms/x \
        --sp-sls-url https://mimic-sp.invalid/api/saml/sls \
        [--status success|partial] [--out <dir>]

Prints a JSON line with ``saml_response`` plus the identity values the harness
must be given to validate it.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

from onelogin.saml2.constants import OneLogin_Saml2_Constants
from onelogin.saml2.utils import OneLogin_Saml2_Utils

# Fixed synthetic InResponseTo. saml_logout_harness.py's ``process`` calls
# process_slo without a request_id, so python3-saml skips the InResponseTo match
# (logout_response.py:98) - this value only has to be schema-valid, not tracked.
_IN_RESPONSE_TO = "_mimic-slo-logout-request-0000000000000000000000001"


def _build_logout_response(
    *, destination: str, issuer: str, in_response_to: str, status: str
) -> str:
    """Hand-build a schema-valid unsigned LogoutResponse (Issuer then Status)."""
    issue_instant = datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"'
        ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
        ' ID="_mimic-slo-logout-response-000000000000000000000001"'
        f' Version="2.0" IssueInstant="{issue_instant}"'
        f' Destination="{destination}" InResponseTo="{in_response_to}">'
        f"<saml:Issuer>{issuer}</saml:Issuer>"
        f'<samlp:Status><samlp:StatusCode Value="{status}"/></samlp:Status>'
        "</samlp:LogoutResponse>"
    )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="make_logout_fixture.py")
    parser.add_argument(
        "--idp-entity-id",
        default="https://mimic-saml-test-idp.invalid/realms/tenetx-mimic",
        help="Issuer of the LogoutResponse (must match the harness --idp-entity-id).",
    )
    parser.add_argument(
        "--sp-sls-url",
        default="https://mimic-sp.invalid/api/saml/sls",
        help="Destination of the LogoutResponse (must match the harness --sp-sls-url).",
    )
    parser.add_argument(
        "--status",
        choices=["success", "partial"],
        default="success",
        help="Logout status. 'partial' emits a non-Success code (rejection test).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Optional directory to also write logout_response.xml + .b64 into.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    status = (
        OneLogin_Saml2_Constants.STATUS_SUCCESS
        if args.status == "success"
        else OneLogin_Saml2_Constants.STATUS_PARTIAL_LOGOUT
    )

    xml = _build_logout_response(
        destination=args.sp_sls_url,
        issuer=args.idp_entity_id,
        in_response_to=_IN_RESPONSE_TO,
        status=status,
    )
    saml_response = OneLogin_Saml2_Utils.deflate_and_base64_encode(xml)
    if isinstance(saml_response, bytes):
        saml_response = saml_response.decode("ascii")

    payload = {
        "saml_response": saml_response,
        "idp_entity_id": args.idp_entity_id,
        "sp_sls_url": args.sp_sls_url,
        "status": status,
        "in_response_to": _IN_RESPONSE_TO,
    }

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        xml_path = os.path.join(args.out, "logout_response.xml")
        b64_path = os.path.join(args.out, "logout_response.b64")
        with open(xml_path, "w", encoding="utf-8") as handle:
            handle.write(xml)
        with open(b64_path, "w", encoding="utf-8") as handle:
            handle.write(saml_response)
        payload["logout_response_xml"] = os.path.abspath(xml_path)
        payload["logout_response_b64"] = os.path.abspath(b64_path)

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
