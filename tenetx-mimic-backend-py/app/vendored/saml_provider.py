# Vendored verbatim from tenetx-source-code-dontpush/tenetx/auth/providers/saml.py
# - do not edit beyond the import-path fix; re-sync manually if the real SAMLProvider
#   changes. Preserves multi-IdP (Okta/Azure AD/Google Workspace/Keycloak/Authentik)
#   attribute-fallback support - see `_extract_user_claims`/`_get_attribute` in this file.
#
# NOTE (vendoring deviation): the real saml.py imports NO internal tenetx/public_url
#   module (stdlib + onelogin.saml2 only), so the planned single import-path fix was
#   not applicable - ZERO edits were made below; every line is byte-for-byte identical
#   to source. public_url.py is vendored as its companion sibling for downstream use.

"""SAML 2.0 authentication provider.

This module handles SAML authentication for any SAML 2.0 compliant IdP:
- Okta
- Azure AD / Entra ID
- Google Workspace
- Auth0
- Keycloak
- OneLogin
- PingFederate
- Any other SAML 2.0 IdP
"""

from __future__ import annotations

import logging
from typing import Optional
from dataclasses import dataclass, field

try:
    from onelogin.saml2.auth import OneLogin_Saml2_Auth
    from onelogin.saml2.errors import OneLogin_Saml2_Error
except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
    OneLogin_Saml2_Auth = None
    OneLogin_Saml2_Error = None
    _SAML_IMPORT_ERROR = exc

LOGGER = logging.getLogger("tenetx.auth.providers.saml")


class SAMLError(Exception):
    """Base exception for SAML errors."""
    pass


class SAMLValidationError(SAMLError):
    """SAML response validation failed."""
    pass


class SAMLConfigurationError(SAMLError):
    """SAML configuration is invalid or missing."""
    pass


def saml_validation_error_code(error: BaseException) -> str:
    """Map safe SAML validation failures to user-actionable error codes."""
    message = str(error).lower()
    if "message of the response is not signed" in message or "no signature found. saml response rejected" in message:
        return "saml_response_not_signed"
    return "saml_validation_failed"


@dataclass
class SAMLAssertion:
    """Parsed and validated SAML assertion."""
    name_id: str                      # Unique user ID (SAML NameID)
    email: str                        # User email
    full_name: str                    # Full name
    first_name: Optional[str] = None  # First name
    last_name: Optional[str] = None   # Last name
    attributes: dict = field(default_factory=dict)  # All SAML attributes


class SAMLProvider:
    """SAML 2.0 authentication provider.

    Supports any SAML 2.0 compliant IdP by using standard SAML fields
    from the idp_connections table.
    """

    def __init__(self, idp_config: dict, org_slug: str, sp_base_url: str = "https://app.tenetx.ai"):
        """Initialize SAML provider.

        Args:
            idp_config: Dict from idp_connections table with:
                - provider: IdP name ('okta', 'azure', 'google', 'saml', etc.)
                - saml_entity_id: IdP Entity ID
                - saml_sso_url: IdP SSO URL
                - saml_certificate: X.509 certificate (PEM format)
                - saml_sp_entity_id: Our Entity ID (optional)
                - saml_acs_url: Our ACS URL (optional)
            org_slug: Organization slug for multi-tenant routing
            sp_base_url: Base URL for SP endpoints (default: https://app.tenetx.ai)
        """
        if OneLogin_Saml2_Auth is None:
            raise SAMLConfigurationError(
                "python3-saml is not installed (missing onelogin). "
                "Install the SAML dependency to use this provider."
            ) from _SAML_IMPORT_ERROR
        self.provider = idp_config.get('provider', 'saml')
        self.org_slug = org_slug
        self.sp_base_url = sp_base_url

        # IdP configuration
        self.idp_entity_id = idp_config.get('saml_entity_id')
        self.idp_sso_url = idp_config.get('saml_sso_url')
        self.idp_certificate = idp_config.get('saml_certificate')

        # SP configuration (use defaults if not configured)
        self.sp_entity_id = idp_config.get('saml_sp_entity_id') or f"{sp_base_url}/saml/metadata"
        self.sp_acs_url = idp_config.get('saml_acs_url') or f"{sp_base_url}/api/saml/acs"

        # Validate required fields
        if not self.idp_entity_id:
            raise SAMLConfigurationError("Missing saml_entity_id in IdP configuration")
        if not self.idp_sso_url:
            raise SAMLConfigurationError("Missing saml_sso_url in IdP configuration")
        if not self.idp_certificate:
            raise SAMLConfigurationError("Missing saml_certificate in IdP configuration")

        LOGGER.info(f"Initialized SAML provider for {self.provider} (org: {org_slug})")

    def _build_saml_settings(self) -> dict:
        """Build python3-saml settings dict.

        Returns:
            Settings dict for OneLogin_Saml2_Auth
        """
        return {
            "strict": True,  # Strict SAML validation
            "debug": False,
            "sp": {
                "entityId": self.sp_entity_id,
                "assertionConsumerService": {
                    "url": self.sp_acs_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                },
                "singleLogoutService": {
                    "url": f"{self.sp_base_url}/api/saml/sls",
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                },
                "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
                "x509cert": "",  # SP doesn't need cert for receiving assertions
                "privateKey": ""
            },
            "idp": {
                "entityId": self.idp_entity_id,
                "singleSignOnService": {
                    "url": self.idp_sso_url,
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                },
                "singleLogoutService": {
                    "url": "",  # Optional
                    "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                },
                "x509cert": self._normalize_certificate(self.idp_certificate)
            },
            "security": {
                "nameIdEncrypted": False,
                "authnRequestsSigned": False,
                "logoutRequestSigned": False,
                "logoutResponseSigned": False,
                "signMetadata": False,
                # Google Workspace signs the SAML Response, not each Assertion.
                # Require a signed message so forged unsigned responses are rejected.
                "wantMessagesSigned": True,
                "wantAssertionsSigned": False,  # Google Workspace signs the Response, not individual Assertions
                "wantAssertionsEncrypted": False,
                "wantNameIdEncrypted": False,
                "requestedAuthnContext": True,
                "signatureAlgorithm": "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
                "digestAlgorithm": "http://www.w3.org/2001/04/xmlenc#sha256"
            }
        }

    def _normalize_certificate(self, cert: str) -> str:
        """Normalize X.509 certificate format.

        Removes headers/footers and whitespace for python3-saml.

        Args:
            cert: Certificate in PEM format (with or without headers)

        Returns:
            Normalized certificate (no headers, no whitespace)
        """
        # Remove common headers/footers
        cert = cert.replace("-----BEGIN CERTIFICATE-----", "")
        cert = cert.replace("-----END CERTIFICATE-----", "")
        cert = cert.replace("-----BEGIN RSA CERTIFICATE-----", "")
        cert = cert.replace("-----END RSA CERTIFICATE-----", "")

        # Remove whitespace
        cert = cert.replace("\n", "").replace("\r", "").replace(" ", "")

        return cert

    def parse_and_validate_response(
        self,
        saml_response_b64: str,
        request_data: dict,
    ) -> SAMLAssertion:
        """Parse and validate SAML response.

        Args:
            saml_response_b64: Base64-encoded SAML Response XML
            request_data: HTTP request data for OneLogin_Saml2_Auth

        Returns:
            SAMLAssertion with user claims

        Raises:
            SAMLValidationError: If validation fails
        """
        try:
            # Build settings
            settings = self._build_saml_settings()

            # Create auth object
            auth = OneLogin_Saml2_Auth(request_data, settings)

            # Process SAML response
            auth.process_response()

            # Get errors (if any)
            errors = auth.get_errors()
            if errors:
                last_error_reason = auth.get_last_error_reason() or ""

                # Google Workspace (and some other IdPs) may not include an
                # AttributeStatement when the admin hasn't configured attribute
                # mapping.  This is harmless — we can still extract the user's
                # email from NameID, which Google always provides.  Treat this
                # specific error as a warning rather than a hard failure.
                _missing_attrs = "There is no AttributeStatement" in last_error_reason
                if _missing_attrs and len(errors) == 1:
                    LOGGER.warning(
                        "SAML response has no AttributeStatement — proceeding "
                        "with NameID only (email from NameID, name fields will "
                        "be empty).  Ask the IdP admin to configure attribute "
                        "mapping for richer user profiles."
                    )
                    # python3-saml sets authenticated=False when process_response
                    # encounters errors, even benign ones.  Skip the
                    # is_authenticated() gate for this specific case — the
                    # signature and timing were already validated.
                else:
                    error_msg = f"SAML validation failed: {', '.join(errors)}"
                    if last_error_reason:
                        error_msg += f" | Reason: {last_error_reason}"
                    LOGGER.error(error_msg)
                    print(f"[SAML ERROR] {error_msg}")
                    raise SAMLValidationError(error_msg)
            else:
                # No errors — verify authentication flag as normal
                if not auth.is_authenticated():
                    raise SAMLValidationError("SAML authentication failed: user not authenticated")

            # Extract user claims
            assertion = self._extract_user_claims(auth)

            LOGGER.info(f"Successfully validated SAML assertion for {assertion.email}")
            return assertion

        except OneLogin_Saml2_Error as e:
            error_msg = f"SAML processing error: {str(e)}"
            LOGGER.error(error_msg)
            raise SAMLValidationError(error_msg) from e
        except SAMLValidationError:
            raise  # Re-raise our own errors without wrapping
        except Exception as e:
            error_msg = f"Unexpected SAML error: {str(e)}"
            LOGGER.exception(error_msg)
            raise SAMLValidationError(error_msg) from e

    def _extract_user_claims(self, auth: OneLogin_Saml2_Auth) -> SAMLAssertion:
        """Extract user claims from authenticated SAML assertion.

        Handles different attribute naming conventions across IdPs:
        - Okta: email, firstName, lastName
        - Azure AD: http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress
        - Google: email, givenName, surname

        Args:
            auth: Authenticated OneLogin_Saml2_Auth instance

        Returns:
            SAMLAssertion with normalized user claims
        """
        attributes = auth.get_attributes()
        name_id = auth.get_nameid()

        # python3-saml may return None for get_nameid() when process_response
        # had errors (even benign ones like missing AttributeStatement).
        # Fall back to parsing NameID directly from the decoded response XML.
        if not name_id:
            try:
                response_xml = auth.get_last_response_xml()
                if response_xml:
                    import xml.etree.ElementTree as ET
                    root = ET.fromstring(response_xml)
                    ns = {
                        'saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
                        'samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
                    }
                    name_id_el = root.find('.//saml:Subject/saml:NameID', ns)
                    if name_id_el is not None and name_id_el.text:
                        name_id = name_id_el.text.strip()
                        LOGGER.info(f"Extracted NameID from raw XML: {name_id}")
            except Exception as e:
                LOGGER.warning(f"Failed to extract NameID from raw XML: {e}")

        LOGGER.info(f"SAML claims extraction: name_id={name_id}, attributes={list(attributes.keys())}")

        # Extract email (try multiple attribute names)
        email = self._get_attribute(attributes, [
            'email',
            'emailAddress',
            'mail',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
            'urn:oid:0.9.2342.19200300.100.1.3',  # OID for email
        ]) or (name_id if name_id and '@' in name_id else None)

        if not email:
            LOGGER.error(
                f"SAML assertion missing email. NameID='{name_id}' is not an email address. "
                "Configure the IdP to include an email attribute or use emailAddress NameID format."
            )
            raise ValueError(
                "SAML login failed: no email address found in the assertion. "
                "Please ask your IT admin to configure the SAML app to send the email attribute."
            )

        # Extract first name
        first_name = self._get_attribute(attributes, [
            'firstName',
            'givenName',
            'given_name',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
            'urn:oid:2.5.4.42',  # OID for givenName
        ])

        # Extract last name
        last_name = self._get_attribute(attributes, [
            'lastName',
            'surname',
            'sn',
            'family_name',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
            'urn:oid:2.5.4.4',  # OID for surname
        ])

        # Construct full name
        full_name = self._get_attribute(attributes, [
            'name',
            'displayName',
            'cn',
            'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
        ])

        if not full_name and (first_name or last_name):
            full_name = f"{first_name or ''} {last_name or ''}".strip()

        if not full_name:
            full_name = email  # Fallback to email

        return SAMLAssertion(
            name_id=name_id,
            email=email,
            full_name=full_name,
            first_name=first_name,
            last_name=last_name,
            attributes=attributes,
        )

    def _get_attribute(self, attributes: dict, names: list[str]) -> Optional[str]:
        """Get first non-empty attribute value from a list of possible names.

        Args:
            attributes: SAML attributes dict
            names: List of possible attribute names to try

        Returns:
            First non-empty attribute value, or None
        """
        for name in names:
            value = attributes.get(name, [])
            if value and len(value) > 0 and value[0]:
                return value[0]
        return None

    def get_sso_url(self, return_to: Optional[str] = None) -> str:
        """Get SSO initiation URL for SP-initiated login.

        Args:
            return_to: Optional return URL after authentication

        Returns:
            URL to redirect user to for SSO login
        """
        # For SP-initiated flow, redirect to IdP SSO URL
        # In production, you'd generate an AuthnRequest here
        return self.idp_sso_url

    def generate_metadata_xml(self) -> str:
        """Generate SP metadata XML for IdP configuration.

        Returns:
            XML metadata document
        """
        settings = self._build_saml_settings()

        from onelogin.saml2.settings import OneLogin_Saml2_Settings
        saml_settings = OneLogin_Saml2_Settings(settings)

        metadata = saml_settings.get_sp_metadata()
        errors = saml_settings.validate_metadata(metadata)

        if errors:
            raise SAMLConfigurationError(f"Invalid SP metadata: {', '.join(errors)}")

        return metadata

    def create_login_request(self, request_data: dict, return_url: Optional[str] = None) -> str:
        """Create SAML AuthnRequest and return SSO URL for SP-initiated flow.

        Args:
            request_data: HTTP request data for OneLogin_Saml2_Auth (must include 'https' key)
            return_url: Optional URL to redirect to after authentication

        Returns:
            SSO URL with SAML AuthnRequest to redirect user to

        Raises:
            SAMLConfigurationError: If SAML settings are invalid
        """
        try:
            # Build settings
            settings = self._build_saml_settings()

            # Create auth object
            auth = OneLogin_Saml2_Auth(request_data, settings)

            # Generate SSO URL with embedded AuthnRequest
            sso_url = auth.login(return_to=return_url)

            LOGGER.info(f"Generated SAML AuthnRequest for {self.provider} (org: {self.org_slug})")
            return sso_url

        except OneLogin_Saml2_Error as e:
            LOGGER.error(f"SAML login request generation failed: {e}")
            raise SAMLConfigurationError(f"Failed to generate SAML login request: {e}")
        except Exception as e:
            LOGGER.error(f"Unexpected error generating SAML login request: {e}")
            raise SAMLConfigurationError(f"Unexpected error: {e}")
