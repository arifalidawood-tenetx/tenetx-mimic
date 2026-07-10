#!/usr/bin/env python3
"""Generate a message-signed SAML Response fixture for the live-ACS Vitest suite.

TEST-ONLY. This produces a throwaway self-signed RSA cert+key and signs a
far-future SAML Response at the MESSAGE level (mirroring Keycloak's
"Sign Response = On, Sign Assertion = Off", which is what the real SP requires:
``wantMessagesSigned: True`` / ``wantAssertionsSigned: False`` at
tenetx-source-code-dontpush/tenetx/auth/providers/saml.py:157-158).

Because the timestamps are pinned far in the future (NotOnOrAfter=2099), the
fixture never expires, so the same signed response validates deterministically
regardless of when the test runs. The private key is generated fresh each run
and never written to disk (only the public cert is emitted, for the validator).

This is a fixture GENERATOR, not product logic: it does NOT validate anything
and shares no code with the real SAMLProvider. The signing primitive comes from
python3-saml's own ``OneLogin_Saml2_Utils.add_sign`` so the signature is exactly
the shape python3-saml verifies on the other side.

Usage:
    python sign_fixture.py --out <dir> --sp-base https://mimic-sp.invalid \
        --idp-entity-id <url> --idp-sso-url <url> --email user@example.invalid

Writes <out>/signed.xml and <out>/cert.pem and prints a JSON line with both
paths plus the values a caller must feed the harness (idp entity id / sso url).
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from onelogin.saml2.constants import OneLogin_Saml2_Constants
from onelogin.saml2.utils import OneLogin_Saml2_Utils

_ISSUE_INSTANT = "2099-01-01T00:00:00Z"
_NOT_BEFORE = "2020-01-01T00:00:00Z"
_NOT_ON_OR_AFTER = "2099-01-01T00:00:00Z"


def _make_cert_and_key(common_name: str) -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
        .not_valid_after(datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc))
        .sign(key, hashes.SHA256())
    )
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    return cert_pem, key_pem


def _build_unsigned_response(
    *, destination: str, audience: str, issuer: str, email: str
) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"'
        ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
        ' ID="_signed-response-00000000000000000000000000000001"'
        f' Version="2.0" IssueInstant="{_ISSUE_INSTANT}" Destination="{destination}">'
        f"<saml:Issuer>{issuer}</saml:Issuer>"
        '<samlp:Status><samlp:StatusCode'
        ' Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
        '<saml:Assertion ID="_signed-assertion-0000000000000000000000000000001"'
        f' Version="2.0" IssueInstant="{_ISSUE_INSTANT}">'
        f"<saml:Issuer>{issuer}</saml:Issuer>"
        "<saml:Subject>"
        '<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">'
        f"{email}</saml:NameID>"
        '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        f'<saml:SubjectConfirmationData NotOnOrAfter="{_NOT_ON_OR_AFTER}"'
        f' Recipient="{destination}"/>'
        "</saml:SubjectConfirmation></saml:Subject>"
        f'<saml:Conditions NotBefore="{_NOT_BEFORE}" NotOnOrAfter="{_NOT_ON_OR_AFTER}">'
        f"<saml:AudienceRestriction><saml:Audience>{audience}</saml:Audience>"
        "</saml:AudienceRestriction></saml:Conditions>"
        f'<saml:AuthnStatement AuthnInstant="{_ISSUE_INSTANT}"'
        ' SessionIndex="_signed-session-0001"><saml:AuthnContext>'
        "<saml:AuthnContextClassRef>"
        "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
        "</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>"
        '<saml:AttributeStatement><saml:Attribute Name="email"'
        ' NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">'
        f"<saml:AttributeValue>{email}</saml:AttributeValue>"
        "</saml:Attribute></saml:AttributeStatement>"
        "</saml:Assertion></samlp:Response>"
    )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="sign_fixture.py")
    parser.add_argument("--out", required=True, help="Output directory for signed.xml + cert.pem.")
    parser.add_argument(
        "--sp-base",
        default="https://mimic-sp.invalid",
        help="SP base URL; Destination=<base>/saml/acs, Audience=<base>/saml/metadata.",
    )
    parser.add_argument("--acs-path", default="/saml/acs", help="ACS path appended to --sp-base.")
    parser.add_argument(
        "--idp-entity-id",
        default="https://mimic-saml-test-idp.invalid/realms/tenetx-mimic",
    )
    parser.add_argument(
        "--idp-sso-url",
        default="https://mimic-saml-test-idp.invalid/realms/tenetx-mimic/protocol/saml",
    )
    parser.add_argument("--email", default="qa-saml-tester@mimic-sp.invalid")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    destination = f"{args.sp_base}{args.acs_path}"
    audience = f"{args.sp_base}/saml/metadata"
    cert_pem, key_pem = _make_cert_and_key("mimic-saml-test-idp.invalid")

    unsigned = _build_unsigned_response(
        destination=destination,
        audience=audience,
        issuer=args.idp_entity_id,
        email=args.email,
    )
    signed = OneLogin_Saml2_Utils.add_sign(
        unsigned,
        key_pem,
        cert_pem,
        sign_algorithm=OneLogin_Saml2_Constants.RSA_SHA256,
        digest_algorithm=OneLogin_Saml2_Constants.SHA256,
    )
    if isinstance(signed, bytes):
        signed = signed.decode("utf-8")

    signed_path = os.path.join(args.out, "signed.xml")
    unsigned_path = os.path.join(args.out, "unsigned.xml")
    cert_path = os.path.join(args.out, "cert.pem")
    with open(signed_path, "w", encoding="utf-8") as handle:
        handle.write(signed)
    # Same Issuer/Destination/Audience as the signed one, minus the signature, so
    # a caller can prove the "message not signed" rejection under the identical
    # IdP config (only the missing signature differs).
    with open(unsigned_path, "w", encoding="utf-8") as handle:
        handle.write(unsigned)
    with open(cert_path, "w", encoding="utf-8") as handle:
        handle.write(cert_pem)

    print(
        json.dumps(
            {
                "signed_xml": os.path.abspath(signed_path),
                "unsigned_xml": os.path.abspath(unsigned_path),
                "cert_pem": os.path.abspath(cert_path),
                "destination": destination,
                "audience": audience,
                "idp_entity_id": args.idp_entity_id,
                "idp_sso_url": args.idp_sso_url,
                "email": args.email,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
