"""Tests for GET /saml/login — the in-process SP-initiated login route (todo 8).

Ports the three vitest cases in ``tenetx-mimic-backend/test/login.test.ts`` and
adds error-shape, request-shape, subprocess-guard, and ``app.request_context``
unit coverage.

DUAL-INTERPRETER STRATEGY (mirrors todo 3's ``test_vendored_imports.py`` defensive
pattern): the mocked cases patch ``app.routes.saml_login.SAMLProvider`` so they run
on ANY interpreter, even one without ``python3-saml`` installed. The single
``test_real_provider_*`` case exercises the REAL vendored provider in-process and
SKIPS when ``onelogin`` is absent, so the full suite is green on the hermes venv
(no onelogin) and additionally proves the real construction path on the reference
venv (``tenetx-source-code-dontpush/.venv``, which ships python3-saml + xmlsec).
"""
from __future__ import annotations

import subprocess
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402
from starlette.requests import Request as StarletteRequest  # noqa: E402

from app.main import app  # noqa: E402
from app.relay_state import decode_relay_state  # noqa: E402
from app.request_context import (  # noqa: E402
    derive_request_host,
    derive_request_scheme,
    first_header_value,
    first_query_value,
)
from app.routes import saml_login as saml_login_module  # noqa: E402
from app.vendored.saml_provider import SAMLConfigurationError  # noqa: E402

# The exact fixture values from login.test.ts:25-28.
IDP_ENTITY_ID = "https://idp.example/entity"
IDP_SSO_URL = "https://idp.example/sso"
IDP_CERT = "DUMMYCERT"
RETURN_URL = "https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out"

# The REAL tenetx-mimic Keycloak realm (plan todo 8's QA scenario). Used only by
# the real-provider test, which needs a valid FQDN SP host: python3-saml's strict
# settings validation rejects TestClient's default single-label "testserver" host
# as sp_acs_url_invalid, so the real-provider test forwards a dotted FQDN Host —
# in production the reverse-proxy Host is always a real FQDN, so this is test-only.
REAL_IDP_ENTITY_ID = "https://keycloak.arifalidawood.com/realms/tenetx-mimic"
REAL_IDP_SSO_URL = "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml"

client = TestClient(app)


def _all_params(**overrides: str) -> dict[str, str]:
    base = {
        "idpEntityId": IDP_ENTITY_ID,
        "idpSsoUrl": IDP_SSO_URL,
        "idpCert": IDP_CERT,
        "returnUrl": RETURN_URL,
    }
    base.update(overrides)
    return base


def _make_echo_provider(record: dict) -> type:
    """A fake SAMLProvider that records its construction + call args and echoes the
    ``return_url`` (the encoded RelayState) into a python3-saml-shaped SSO URL, so
    RelayState/SAMLRequest assertions work without the real onelogin dependency."""

    class _EchoProvider:
        def __init__(self, idp_config, org_slug, sp_base_url):
            self.idp_config = idp_config
            record["idp_config"] = idp_config
            record["org_slug"] = org_slug
            record["sp_base_url"] = sp_base_url

        def create_login_request(self, request_data, return_url=None):
            record["request_data"] = request_data
            record["return_url"] = return_url
            query = urlencode(
                {
                    "SAMLRequest": "FAKE_DEFLATED_B64_AUTHNREQUEST",
                    "RelayState": return_url or "",
                }
            )
            return f"{self.idp_config['saml_sso_url']}?{query}"

    return _EchoProvider


def _make_raising_provider(exc: Exception, *, at_construction: bool = False) -> type:
    """A fake SAMLProvider that raises ``exc`` either during construction or during
    ``create_login_request`` — used to prove BOTH are inside the route's try/except."""

    class _RaisingProvider:
        def __init__(self, idp_config, org_slug, sp_base_url):
            if at_construction:
                raise exc

        def create_login_request(self, request_data, return_url=None):
            raise exc

    return _RaisingProvider


def test_valid_request_redirects_302_with_samlrequest_and_relaystate(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_login_module, "SAMLProvider", _make_echo_provider(record))

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{IDP_SSO_URL}?")
    query = parse_qs(urlsplit(location).query)
    assert query.get("SAMLRequest", [""])[0]
    assert query.get("RelayState", [""])[0] == RETURN_URL


def test_composite_relaystate_when_connection_doc_id_present(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_login_module, "SAMLProvider", _make_echo_provider(record))
    connection_doc_id = "doc123"

    res = client.get(
        "/saml/login",
        params=_all_params(connectionDocId=connection_doc_id),
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{IDP_SSO_URL}?")
    query = parse_qs(urlsplit(location).query)
    assert query.get("SAMLRequest", [""])[0]
    relay_state = query.get("RelayState", [""])[0]
    assert relay_state.startswith("mimicrs:")
    assert decode_relay_state(relay_state) == {
        "returnUrl": RETURN_URL,
        "connectionDocId": connection_doc_id,
    }


def test_missing_required_param_returns_400_json():
    res = client.get(
        "/saml/login",
        params={"idpEntityId": IDP_ENTITY_ID, "idpSsoUrl": IDP_SSO_URL, "returnUrl": RETURN_URL},
        follow_redirects=False,
    )

    assert res.status_code == 400
    assert "application/json" in res.headers.get("content-type", "")
    body = res.json()
    assert body["error"]
    assert "idpCert" in body["error"]


def test_missing_multiple_params_lists_them_in_source_order():
    res = client.get(
        "/saml/login",
        params={"idpSsoUrl": IDP_SSO_URL},
        follow_redirects=False,
    )

    assert res.status_code == 400
    assert res.json() == {
        "error": "missing required query param(s): idpEntityId, idpCert, returnUrl"
    }


def test_saml_configuration_error_from_create_returns_502(monkeypatch):
    monkeypatch.setattr(
        saml_login_module,
        "SAMLProvider",
        _make_raising_provider(SAMLConfigurationError("boom")),
    )

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "boom"}


def test_saml_configuration_error_at_construction_returns_502(monkeypatch):
    monkeypatch.setattr(
        saml_login_module,
        "SAMLProvider",
        _make_raising_provider(
            SAMLConfigurationError("Missing saml_entity_id in IdP configuration"),
            at_construction=True,
        ),
    )

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "Missing saml_entity_id in IdP configuration"}


def test_unexpected_exception_returns_generic_502(monkeypatch):
    monkeypatch.setattr(
        saml_login_module,
        "SAMLProvider",
        _make_raising_provider(RuntimeError("kaboom")),
    )

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "login request could not run"}


def test_request_data_and_idp_config_shapes_match_harness(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_login_module, "SAMLProvider", _make_echo_provider(record))

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 302
    assert record["request_data"] == {
        "https": "off",
        "http_host": "testserver",
        "script_name": "/saml/login",
        "server_port": 80,
        "get_data": {},
        "post_data": {},
    }
    assert record["idp_config"] == {
        "provider": "keycloak",
        "saml_entity_id": IDP_ENTITY_ID,
        "saml_sso_url": IDP_SSO_URL,
        "saml_certificate": IDP_CERT,
        "saml_acs_url": "http://testserver/saml/acs",
    }
    assert record["org_slug"] == "mimic-tryout"
    assert record["sp_base_url"] == "http://testserver"
    assert record["return_url"] == RETURN_URL


def test_forwarded_headers_drive_sp_base_url(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_login_module, "SAMLProvider", _make_echo_provider(record))

    res = client.get(
        "/saml/login",
        params=_all_params(),
        headers={
            "X-Forwarded-Host": "saml-proxy.example.com, internal.rewrite",
            "X-Forwarded-Proto": "https",
        },
        follow_redirects=False,
    )

    assert res.status_code == 302
    assert record["sp_base_url"] == "https://saml-proxy.example.com"
    assert record["idp_config"]["saml_acs_url"] == "https://saml-proxy.example.com/saml/acs"
    assert record["request_data"]["https"] == "on"
    assert record["request_data"]["http_host"] == "saml-proxy.example.com"
    assert record["request_data"]["server_port"] == 443


def test_no_subprocess_is_spawned_by_the_route(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("/saml/login must build the AuthnRequest in-process, never via subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    monkeypatch.setattr(subprocess, "run", _boom)
    record: dict = {}
    monkeypatch.setattr(saml_login_module, "SAMLProvider", _make_echo_provider(record))

    res = client.get("/saml/login", params=_all_params(), follow_redirects=False)

    assert res.status_code == 302


def test_real_provider_generates_302_in_process():
    import app.vendored.saml_provider as vendored

    if vendored.OneLogin_Saml2_Auth is None:
        pytest.skip("python3-saml (onelogin) not installed in this interpreter")

    res = client.get(
        "/saml/login",
        params={
            "idpEntityId": REAL_IDP_ENTITY_ID,
            "idpSsoUrl": REAL_IDP_SSO_URL,
            "idpCert": IDP_CERT,
            "returnUrl": RETURN_URL,
        },
        headers={"X-Forwarded-Host": "saml-proxy.example.com", "X-Forwarded-Proto": "https"},
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{REAL_IDP_SSO_URL}?")
    query = parse_qs(urlsplit(location).query)
    assert query.get("SAMLRequest", [""])[0]
    assert query.get("RelayState", [""])[0] == RETURN_URL


def _make_request(headers: dict[str, str]) -> StarletteRequest:
    raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
    return StarletteRequest(
        {"type": "http", "method": "GET", "path": "/saml/login", "query_string": b"", "headers": raw}
    )


def test_first_query_value_trims_and_handles_none():
    assert first_query_value(None) == ""
    assert first_query_value("") == ""
    assert first_query_value("  spaced  ") == "spaced"


def test_first_header_value_takes_first_comma_value():
    assert first_header_value(None) == ""
    assert first_header_value("a.example, b.internal") == "a.example"
    assert first_header_value("  solo  ") == "solo"


def test_derive_request_host_prefers_forwarded_then_falls_back():
    assert (
        derive_request_host(_make_request({"X-Forwarded-Host": "public.example, x", "Host": "internal"}))
        == "public.example"
    )
    assert derive_request_host(_make_request({"Host": "internal.host"})) == "internal.host"


def test_derive_request_scheme_is_header_only_defaulting_http():
    assert derive_request_scheme(_make_request({"Host": "h"})) == "http"
    assert derive_request_scheme(_make_request({"X-Forwarded-Proto": "https", "Host": "h"})) == "https"
    assert derive_request_scheme(_make_request({"X-Forwarded-Proto": "HTTPS", "Host": "h"})) == "https"
    assert derive_request_scheme(_make_request({"X-Forwarded-Proto": "http", "Host": "h"})) == "http"
