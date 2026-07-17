"""Tests for app/gcp_credentials.py — the keyless Keycloak-OIDC + GCP WIF factory.

Fully hermetic: no live Keycloak, no GCP STS, no network. The Keycloak token
endpoint is mocked by patching ``gcp_credentials.urllib.request.urlopen``; the WIF
STS exchange never runs (credential construction does no I/O). The memoized
singleton is reset per test so each test's env/config takes effect.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from google.auth import exceptions as google_auth_exceptions
from google.auth import identity_pool

from app import gcp_credentials

_KEYCLOAK_ENV = {
    "KEYCLOAK_TOKEN_URL": "https://keycloak.example/realms/r/protocol/openid-connect/token",
    "KEYCLOAK_CLIENT_ID": "mimic-backend",
    "KEYCLOAK_CLIENT_SECRET": "shhh-secret",
}
_WIF_ENV = {
    "GCP_WIF_AUDIENCE": "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/kc",
    "GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@x.iam.gserviceaccount.com:generateAccessToken",
}


def _clear_all_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "KEYCLOAK_TOKEN_URL",
        "KEYCLOAK_ISSUER",
        "KEYCLOAK_CLIENT_ID",
        "KEYCLOAK_CLIENT_SECRET",
        "GCP_WIF_AUDIENCE",
        "GCP_WIF_STS_TOKEN_URL",
        "GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL",
        "GCP_WIF_SUBJECT_TOKEN_TYPE",
        "GCP_WIF_CREDENTIAL_CONFIG",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GCP_PROJECT_ID",
        "FIREBASE_PROJECT_ID",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_all_env(monkeypatch)
    monkeypatch.setattr(gcp_credentials, "_credentials_singleton", None)


def _configure_wif(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in {**_KEYCLOAK_ENV, **_WIF_ENV}.items():
        monkeypatch.setenv(key, value)


# --------------------------------------------------------------------------- #
# get_project_id
# --------------------------------------------------------------------------- #
def test_project_id_defaults_to_tenetx_qa_scores() -> None:
    assert gcp_credentials.get_project_id() == "tenetx-qa-scores"


def test_project_id_prefers_gcp_then_firebase_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "from-firebase")
    assert gcp_credentials.get_project_id() == "from-firebase"
    monkeypatch.setenv("GCP_PROJECT_ID", "from-gcp")
    assert gcp_credentials.get_project_id() == "from-gcp"


# --------------------------------------------------------------------------- #
# get_google_credentials — fail-closed paths
# --------------------------------------------------------------------------- #
def test_returns_none_when_keycloak_unconfigured() -> None:
    assert gcp_credentials.get_google_credentials() is None


def test_returns_none_when_wif_audience_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in _KEYCLOAK_ENV.items():
        monkeypatch.setenv(key, value)
    assert gcp_credentials.get_google_credentials() is None


def test_derives_token_url_from_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEYCLOAK_ISSUER", "https://keycloak.example/realms/r/")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "mimic-backend")
    monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "shhh")
    for key, value in _WIF_ENV.items():
        monkeypatch.setenv(key, value)

    creds = gcp_credentials.get_google_credentials()

    assert isinstance(creds, identity_pool.Credentials)
    supplier = creds._subject_token_supplier
    assert supplier._token_url == (
        "https://keycloak.example/realms/r/protocol/openid-connect/token"
    )


# --------------------------------------------------------------------------- #
# get_google_credentials — happy path
# --------------------------------------------------------------------------- #
def test_builds_identity_pool_credentials_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_wif(monkeypatch)

    creds = gcp_credentials.get_google_credentials()

    assert isinstance(creds, identity_pool.Credentials)
    assert isinstance(
        creds._subject_token_supplier, gcp_credentials._KeycloakSubjectTokenSupplier
    )


def test_credentials_are_memoized(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_wif(monkeypatch)
    first = gcp_credentials.get_google_credentials()
    second = gcp_credentials.get_google_credentials()
    assert first is second


# --------------------------------------------------------------------------- #
# _KeycloakSubjectTokenSupplier — mocked token endpoint
# --------------------------------------------------------------------------- #
class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


def test_supplier_posts_client_credentials_and_returns_access_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_urlopen(req: Any, timeout: float) -> _FakeResponse:  # noqa: ARG001
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["body"] = req.data.decode("utf-8")
        return _FakeResponse({"access_token": "kc-access-token-123"})

    monkeypatch.setattr(gcp_credentials.urllib.request, "urlopen", fake_urlopen)
    supplier = gcp_credentials._KeycloakSubjectTokenSupplier(
        "https://keycloak.example/token", "cid", "csecret"
    )

    token = supplier.get_subject_token(context=None, request=None)

    assert token == "kc-access-token-123"
    assert captured["method"] == "POST"
    assert captured["url"] == "https://keycloak.example/token"
    assert "grant_type=client_credentials" in captured["body"]
    assert "client_id=cid" in captured["body"]


def test_supplier_raises_refresh_error_when_access_token_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        gcp_credentials.urllib.request,
        "urlopen",
        lambda req, timeout: _FakeResponse({"error": "invalid_client"}),  # noqa: ARG005
    )
    supplier = gcp_credentials._KeycloakSubjectTokenSupplier(
        "https://keycloak.example/token", "cid", "csecret"
    )

    with pytest.raises(google_auth_exceptions.RefreshError):
        supplier.get_subject_token(context=None, request=None)


def test_supplier_error_message_never_leaks_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import urllib.error

    def boom(req: Any, timeout: float) -> None:  # noqa: ARG001
        raise urllib.error.URLError("connection refused with secret=csecret in body")

    monkeypatch.setattr(gcp_credentials.urllib.request, "urlopen", boom)
    supplier = gcp_credentials._KeycloakSubjectTokenSupplier(
        "https://keycloak.example/token", "cid", "csecret"
    )

    with pytest.raises(google_auth_exceptions.RefreshError) as exc_info:
        supplier.get_subject_token(context=None, request=None)
    # Only the error TYPE name is surfaced — never the client secret or body.
    assert "csecret" not in str(exc_info.value)
    assert "URLError" in str(exc_info.value)


# --------------------------------------------------------------------------- #
# external_account config JSON loading (non-secret) + private-key refusal
# --------------------------------------------------------------------------- #
def test_config_provides_audience_when_env_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    config = {
        "type": "external_account",
        "audience": "//iam.googleapis.com/projects/9/from-config",
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": "https://sts.googleapis.com/v1/token",
        "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/x:generateAccessToken",
    }
    path = tmp_path / "wif.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    for key, value in _KEYCLOAK_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("GCP_WIF_CREDENTIAL_CONFIG", str(path))

    creds = gcp_credentials.get_google_credentials()

    assert isinstance(creds, identity_pool.Credentials)
    assert creds._audience == "//iam.googleapis.com/projects/9/from-config"


def test_config_with_private_key_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    config = {
        "type": "service_account",
        "audience": "//should-not-be-used",
        "private_key": "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
    }
    path = tmp_path / "sa.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    for key, value in _KEYCLOAK_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("GCP_WIF_CREDENTIAL_CONFIG", str(path))

    # No env audience + refused config => fail-closed None (never reads the key).
    assert gcp_credentials.get_google_credentials() is None
