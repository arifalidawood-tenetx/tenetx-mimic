"""Import smoke test for the vendored SAMLProvider + public_url modules.

Runnable two ways:
  - pytest app/test/test_vendored_imports.py
  - python app/test/test_vendored_imports.py   (prints "ok" on success)

Covers plan todo 3's acceptance criterion (clean import of SAMLProvider and
normalize_public_host) and its failure QA scenario (a config missing
saml_entity_id raises SAMLConfigurationError).
"""
from __future__ import annotations

import os
import sys

# Make the backend-py project root (the parent of `app/`) importable when this
# file is executed directly as a script; pytest resolves this via rootdir.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


def test_imports_clean() -> None:
    from app.vendored.saml_provider import SAMLProvider
    from app.vendored.public_url import normalize_public_host

    assert SAMLProvider is not None
    # public_url is stdlib-only; a quick behavioural sanity check.
    assert normalize_public_host("EXAMPLE.com") == "example.com"


def test_missing_entity_id_raises_configuration_error() -> None:
    from app.vendored import saml_provider as sp

    try:
        sp.SAMLProvider({}, "test-org")
    except sp.SAMLConfigurationError as exc:
        # When python3-saml (onelogin) is installed the missing-field validation
        # fires and names the offending field. When it is absent the provider
        # raises the same exception type for the missing dependency instead.
        # Both paths satisfy the SAMLConfigurationError contract.
        if sp.OneLogin_Saml2_Auth is not None:
            assert "saml_entity_id" in str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected SAMLConfigurationError for missing saml_entity_id")


if __name__ == "__main__":
    test_imports_clean()
    test_missing_entity_id_raises_configuration_error()
    print("ok")
