"""Tests for POST /verify-metadata (todo 4).

Two layers:

  * Pure-function parity — :func:`parse_saml_metadata` / :func:`is_allowed_metadata_host`
    ported one-to-one from tenetx-mimic-backend/test/samlMetadata.test.ts (same
    fixtures, same assertions).
  * Route error-status mapping — the 400/403/422/502/200 branches of
    index.ts:141-189, driven through FastAPI's TestClient. The Firebase auth
    dependency (``require_tenetx_user``) is exercised for real on the 401 path and
    replaced with a ``dependency_overrides`` fake @tenetx.ai user on the others, so
    the full route logic is proven end-to-end WITHOUT needing a live Firebase ID
    token (the fixture/override pattern todo 5 established in test_auth.py).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

pytest.importorskip("defusedxml")
pytest.importorskip("httpx")

from app.routes import verify_metadata as vm
from app.routes.verify_metadata import is_allowed_metadata_host, parse_saml_metadata

_FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name: str) -> str:
    return (_FIXTURES / name).read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# parse_saml_metadata — ported from samlMetadata.test.ts                       #
# --------------------------------------------------------------------------- #
def test_parses_keycloak_realm_descriptor_fixture() -> None:
    result = parse_saml_metadata(_fixture("keycloak-metadata.xml"))
    assert result is not None
    assert "tenetx-mimic" in result["entity_id"]
    assert result["sso_url"].startswith("https://")
    assert result["slo_url"].startswith("https://")
    assert "tenetx-mimic" in result["slo_url"]
    assert result["certificate"].startswith("-----BEGIN CERTIFICATE-----\n")
    assert "-----END CERTIFICATE-----" in result["certificate"]


def test_parses_authentik_saml_provider_metadata_fixture() -> None:
    result = parse_saml_metadata(_fixture("authentik-metadata.xml"))
    assert result is not None
    assert re.match(r"^https://authentik\.arifalidawood\.com", result["entity_id"])
    assert "tenetx-mimic" in result["sso_url"]
    assert result["slo_url"] == ""
    assert result["certificate"].startswith("-----BEGIN CERTIFICATE-----\n")


def test_returns_none_for_empty_input() -> None:
    assert parse_saml_metadata("") is None
    assert parse_saml_metadata("   ") is None


def test_returns_none_for_malformed_xml_with_no_saml_fields() -> None:
    assert parse_saml_metadata("<not><valid</not>") is None
    assert parse_saml_metadata("<html><body>not saml</body></html>") is None


def test_slo_prefers_http_redirect_over_http_post_regardless_of_document_order() -> None:
    xml = """<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/slo/post"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/slo/redirect"/>
  </IDPSSODescriptor>
</EntityDescriptor>"""
    result = parse_saml_metadata(xml)
    assert result is not None
    assert result["slo_url"] == "https://idp.example/slo/redirect"


def test_falls_back_to_http_post_slo_when_no_http_redirect_present() -> None:
    xml = """<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/slo/post"/>
  </IDPSSODescriptor>
</EntityDescriptor>"""
    result = parse_saml_metadata(xml)
    assert result is not None
    assert result["slo_url"] == "https://idp.example/slo/post"


def test_slo_url_empty_when_no_single_logout_service_present() -> None:
    xml = """<?xml version="1.0"?>
<EntityDescriptor entityID="https://idp.example/entity">
  <IDPSSODescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/sso"/>
  </IDPSSODescriptor>
</EntityDescriptor>"""
    result = parse_saml_metadata(xml)
    assert result is not None
    assert result["slo_url"] == ""


# --------------------------------------------------------------------------- #
# is_allowed_metadata_host — ported from samlMetadata.test.ts                  #
# --------------------------------------------------------------------------- #
def test_allows_the_two_known_idp_hosts() -> None:
    assert is_allowed_metadata_host("keycloak.arifalidawood.com") is True
    assert is_allowed_metadata_host("authentik.arifalidawood.com") is True


def test_rejects_any_other_host_ssrf_guard() -> None:
    assert is_allowed_metadata_host("evil.example.com") is False
    assert is_allowed_metadata_host("169.254.169.254") is False


# --------------------------------------------------------------------------- #
# Route error-status mapping (index.ts:141-189) via TestClient                 #
# --------------------------------------------------------------------------- #
class _FakeResponse:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300


class _FakeAsyncClient:
    def __init__(self, response: _FakeResponse | None, exc: Exception | None) -> None:
        self._response = response
        self._exc = exc

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    async def get(self, _url: str, **_kwargs: object) -> _FakeResponse:
        if self._exc is not None:
            raise self._exc
        assert self._response is not None
        return self._response


def _patch_fetch(
    monkeypatch: pytest.MonkeyPatch,
    *,
    response: _FakeResponse | None = None,
    exc: Exception | None = None,
) -> None:
    def factory(*_args: object, **_kwargs: object) -> _FakeAsyncClient:
        return _FakeAsyncClient(response=response, exc=exc)

    monkeypatch.setattr(vm.httpx, "AsyncClient", factory)


def _forbid_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("fetch ran before the SSRF allowlist check")

    monkeypatch.setattr(vm.httpx, "AsyncClient", _boom)


@pytest.fixture
def authed_client():
    from fastapi.testclient import TestClient

    from app.auth import AuthenticatedUser, require_tenetx_user
    from app.main import app

    app.dependency_overrides[require_tenetx_user] = lambda: AuthenticatedUser(
        uid="test-uid", email="qa-tester@tenetx.ai", email_verified=True
    )
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.pop(require_tenetx_user, None)


@pytest.fixture
def unauthed_client():
    from fastapi.testclient import TestClient

    from app.auth import require_tenetx_user
    from app.main import app

    app.dependency_overrides.pop(require_tenetx_user, None)
    with TestClient(app) as client:
        yield client


def test_route_requires_auth_401_without_bearer(unauthed_client) -> None:
    resp = unauthed_client.post(
        "/verify-metadata",
        json={"metadataUrl": "https://keycloak.arifalidawood.com/x"},
    )
    assert resp.status_code == 401
    assert resp.json() == {"error": "Missing or invalid Authorization header"}


def test_route_400_when_metadata_url_missing(authed_client) -> None:
    resp = authed_client.post("/verify-metadata", json={})
    assert resp.status_code == 400
    assert resp.json() == {"error": "metadataUrl is required"}


def test_route_400_when_metadata_url_not_a_valid_url(authed_client) -> None:
    resp = authed_client.post("/verify-metadata", json={"metadataUrl": "not a url"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "metadataUrl is not a valid URL"}


def test_route_403_when_host_not_allowlisted_before_any_fetch(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _forbid_fetch(monkeypatch)
    resp = authed_client.post(
        "/verify-metadata", json={"metadataUrl": "https://evil.example.com/meta"}
    )
    assert resp.status_code == 403
    assert resp.json() == {"error": "host not allowlisted: evil.example.com"}


def test_route_403_for_link_local_metadata_ip_before_any_fetch(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _forbid_fetch(monkeypatch)
    resp = authed_client.post(
        "/verify-metadata",
        json={"metadataUrl": "https://169.254.169.254/latest/meta-data/"},
    )
    assert resp.status_code == 403
    assert resp.json() == {"error": "host not allowlisted: 169.254.169.254"}


def test_route_200_returns_parsed_metadata_shape(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fetch(monkeypatch, response=_FakeResponse(200, _fixture("keycloak-metadata.xml")))
    resp = authed_client.post(
        "/verify-metadata",
        json={
            "metadataUrl": "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml/descriptor"
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"entity_id", "sso_url", "slo_url", "certificate"}
    assert body["entity_id"] == "https://keycloak.arifalidawood.com/realms/tenetx-mimic"
    assert (
        body["sso_url"]
        == "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml"
    )
    assert (
        body["slo_url"]
        == "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml"
    )
    assert body["certificate"].startswith("-----BEGIN CERTIFICATE-----\n")
    assert body["certificate"].endswith("-----END CERTIFICATE-----")


def test_route_502_when_fetch_returns_non_2xx(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fetch(monkeypatch, response=_FakeResponse(500, "upstream error"))
    resp = authed_client.post(
        "/verify-metadata",
        json={"metadataUrl": "https://keycloak.arifalidawood.com/descriptor"},
    )
    assert resp.status_code == 502
    assert resp.json() == {"error": "metadata fetch failed: 500"}


def test_route_502_when_fetch_raises(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fetch(monkeypatch, exc=RuntimeError("connection refused"))
    resp = authed_client.post(
        "/verify-metadata",
        json={"metadataUrl": "https://keycloak.arifalidawood.com/descriptor"},
    )
    assert resp.status_code == 502
    assert resp.json() == {"error": "failed to fetch metadata"}


def test_route_422_when_metadata_unparseable(
    authed_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fetch(monkeypatch, response=_FakeResponse(200, "<html><body>not saml</body></html>"))
    resp = authed_client.post(
        "/verify-metadata",
        json={"metadataUrl": "https://keycloak.arifalidawood.com/descriptor"},
    )
    assert resp.status_code == 422
    assert resp.json() == {"error": "failed to parse SAML metadata"}
