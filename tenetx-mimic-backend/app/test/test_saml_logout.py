"""Tests for GET /saml/logout + GET /saml/sls — the in-process SAML SLO routes (todo 10).

Ports the vitest assertions in ``tenetx-mimic-backend/test/logout.test.ts`` and adds
settings-shape, request-shape (the ``server_port`` omission), Firestore-override, and
no-subprocess coverage.

The plan's acceptance criterion is that BOTH the ``auth.logout()`` initiate path and
the ``auth.process_slo()`` process path are exercised EXPLICITLY, so the two test
groups are named ``test_logout_initiate_*`` (``GET /saml/logout``) and
``test_sls_process_slo_*`` (``GET /saml/sls``).

DUAL-INTERPRETER STRATEGY (todos 8/9's established pattern): the mocked cases patch
``app.routes.saml_logout.OneLogin_Saml2_Auth`` so they run on ANY interpreter, even
one without ``python3-saml``. The two ``test_real_provider_*`` cases drive the REAL
toolkit in-process and SKIP when ``onelogin`` is absent — so the suite is green on the
hermes venv (no onelogin) and additionally proves the settings dict is valid enough
for ``OneLogin_Saml2_Auth`` to construct and ``.logout()``/``.process_slo()`` to run
without crashing on the reference venv (``tenetx-source-code-dontpush/.venv``). A
rejected/malformed ``process_slo`` is a VALID outcome (same principle as todo 9's
unsigned-response rejection), never a bug.
"""
from __future__ import annotations

import subprocess
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.relay_state import decode_relay_state, encode_relay_state  # noqa: E402
from app.request_context import is_allowed_relay_state  # noqa: E402
from app.routes import saml_logout as saml_logout_module  # noqa: E402
from app.routes.saml_logout import (  # noqa: E402
    OneLogin_Saml2_Error,
    _build_settings,
    _normalize_cert,
    _sp_request_data,
)
from app.status_token import verify_status  # noqa: E402

client = TestClient(app)

# Fixture values (parity with logout.test.ts).
IDP_SLO_URL = "https://idp.example/slo"
IDP_ENTITY_ID = "https://idp.example/entity"
IDP_CERT = "DUMMYCERT"
RETURN_URL_ORIGIN = "https://tenetx-mimic.web.app"
RETURN_URL = f"{RETURN_URL_ORIGIN}/mimic/TEN-1/try-it-out"
NAME_ID = "qa-saml-tester@example.test"

# The REAL tenetx-mimic Keycloak realm (plan todo 10's QA scenario). The real-provider
# tests need a valid FQDN SP host: python3-saml's strict settings validation rejects
# TestClient's default single-label "testserver" host, so they forward a dotted FQDN
# via X-Forwarded-Host (in production the reverse-proxy Host is always a real FQDN).
REAL_IDP_ENTITY_ID = "https://keycloak.arifalidawood.com/realms/tenetx-mimic"
REAL_IDP_SLO_URL = "https://keycloak.arifalidawood.com/realms/tenetx-mimic/protocol/saml"
FWD_HEADERS = {"X-Forwarded-Host": "saml-proxy.example.com", "X-Forwarded-Proto": "https"}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Pin a deterministic allowlist so the open-redirect guard uses the default
    origin. (Firestore/WIF credentials are now mocked at the get_google_credentials
    boundary by the tests that need them, not via env — no env var to clean here.)"""
    monkeypatch.delenv("ALLOWED_ORIGIN", raising=False)


def _logout_params(**overrides: str) -> dict[str, str]:
    base = {
        "idpSloUrl": IDP_SLO_URL,
        "idpEntityId": IDP_ENTITY_ID,
        "idpCert": IDP_CERT,
        "returnUrl": RETURN_URL,
    }
    base.update(overrides)
    return base


# --- Fake OneLogin_Saml2_Auth factories (interpreter-independent) -------------------


def _make_logout_auth(record: dict, *, at_construction_error: Exception | None = None):
    """A fake auth that records construction args + echoes the idp SLO URL (from the
    settings it received) into a python3-saml-shaped redirect carrying the return_to
    RelayState — so SAMLRequest/RelayState assertions work without real onelogin."""

    class _LogoutAuth:
        def __init__(self, request_data, settings):
            if at_construction_error is not None:
                raise at_construction_error
            record["request_data"] = request_data
            record["settings"] = settings
            self._idp_slo = settings["idp"]["singleLogoutService"]["url"]

        def logout(self, return_to=None, name_id=None):
            record["return_to"] = return_to
            record["name_id"] = name_id
            query = urlencode(
                {"SAMLRequest": "FAKE_DEFLATED_LOGOUTREQUEST", "RelayState": return_to or ""}
            )
            return f"{self._idp_slo}?{query}"

    return _LogoutAuth


def _make_logout_auth_raising(exc: Exception):
    class _LogoutAuth:
        def __init__(self, request_data, settings):
            pass

        def logout(self, return_to=None, name_id=None):
            raise exc

    return _LogoutAuth


def _make_process_auth(
    record: dict,
    *,
    errors: list[str] | None = None,
    reason: str = "",
    slo_return: str | None = None,
    at_construction_error: Exception | None = None,
    process_error: Exception | None = None,
):
    """A fake auth for process_slo: records construction + call args, returns the
    configured error/reason/slo_return, or raises where asked."""

    class _ProcessAuth:
        def __init__(self, request_data, settings):
            if at_construction_error is not None:
                raise at_construction_error
            record["request_data"] = request_data
            record["settings"] = settings

        def process_slo(self, keep_local_session=True):
            record["keep_local_session"] = keep_local_session
            if process_error is not None:
                raise process_error
            return slo_return

        def get_errors(self):
            return list(errors or [])

        def get_last_error_reason(self):
            return reason

    return _ProcessAuth


# --- Pure-function unit tests (no onelogin needed) ----------------------------------


def test_normalize_cert_strips_pem_and_whitespace():
    assert _normalize_cert(None) == ""
    assert _normalize_cert("") == ""
    pem = "-----BEGIN CERTIFICATE-----\nAAAA BBBB\r\nCCCC\n-----END CERTIFICATE-----"
    assert _normalize_cert(pem) == "AAAABBBBCCCC"
    assert _normalize_cert("-----BEGIN RSA CERTIFICATE-----\nZZ\n-----END RSA CERTIFICATE-----") == "ZZ"


def test_sp_request_data_omits_server_port():
    data = _sp_request_data("https://sp.example/saml/sls", get_data={"SAMLResponse": "x"})
    assert data == {
        "https": "on",
        "http_host": "sp.example",
        "script_name": "/saml/sls",
        "get_data": {"SAMLResponse": "x"},
        "post_data": {},
    }
    # THE critical divergence from todos 8/9's request_data shape.
    assert "server_port" not in data


def test_sp_request_data_http_and_port_live_in_http_host():
    data = _sp_request_data("http://sp.example:8443/saml/sls", get_data={})
    assert data["https"] == "off"
    assert data["http_host"] == "sp.example:8443"
    assert data["script_name"] == "/saml/sls"
    assert "server_port" not in data


def test_build_settings_three_deviations_and_inert_fields():
    settings = _build_settings(
        "https://sp.example", "https://sp.example/saml/sls", IDP_ENTITY_ID, IDP_SLO_URL, IDP_CERT
    )
    assert settings["strict"] is True
    # Deviation 1: SP SLS is the route's own /saml/sls (not /api/saml/sls).
    assert settings["sp"]["singleLogoutService"]["url"] == "https://sp.example/saml/sls"
    # Deviation 2: idp SLO is the passed idp_slo_url (product leaves it "").
    assert settings["idp"]["singleLogoutService"]["url"] == IDP_SLO_URL
    # idp SSO is pinned to idp_slo_url ALWAYS (validator requires it for pure SLO).
    assert settings["idp"]["singleSignOnService"]["url"] == IDP_SLO_URL
    # Deviation 3: unsigned SLO — MUST be False (the product uses True).
    assert settings["security"]["wantMessagesSigned"] is False
    # Inert-but-required SP fields ported faithfully from the harness.
    assert settings["sp"]["entityId"] == "https://sp.example/saml/metadata"
    assert settings["sp"]["assertionConsumerService"]["url"] == "https://sp.example/api/saml/acs"
    assert settings["idp"]["entityId"] == IDP_ENTITY_ID
    assert settings["idp"]["x509cert"] == "DUMMYCERT"
    # The remaining security block matches the product's verbatim.
    sec = settings["security"]
    assert sec["logoutRequestSigned"] is False
    assert sec["logoutResponseSigned"] is False
    assert sec["wantAssertionsSigned"] is False
    assert sec["requestedAuthnContext"] is True
    assert sec["signatureAlgorithm"] == "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
    assert sec["digestAlgorithm"] == "http://www.w3.org/2001/04/xmlenc#sha256"


# --- GET /saml/logout — the auth.logout() initiate path ------------------------------


def test_logout_initiate_missing_required_param_returns_400():
    res = client.get(
        "/saml/logout",
        params={"idpSloUrl": IDP_SLO_URL, "idpEntityId": IDP_ENTITY_ID, "idpCert": IDP_CERT},
        follow_redirects=False,
    )

    assert res.status_code == 400
    assert "application/json" in res.headers.get("content-type", "")
    assert res.json() == {"error": "missing required query param(s): returnUrl"}


def test_logout_initiate_missing_multiple_params_lists_them_in_source_order():
    res = client.get(
        "/saml/logout", params={"idpEntityId": IDP_ENTITY_ID}, follow_redirects=False
    )

    assert res.status_code == 400
    assert res.json() == {
        "error": "missing required query param(s): idpSloUrl, idpCert, returnUrl"
    }


def test_logout_initiate_success_redirects_302_to_idp_slo(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_logout_module, "OneLogin_Saml2_Auth", _make_logout_auth(record))

    res = client.get("/saml/logout", params=_logout_params(), follow_redirects=False)

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{IDP_SLO_URL}?")
    query = parse_qs(urlsplit(location).query)
    assert query.get("SAMLRequest", [""])[0]
    # return_to (the RelayState) is the encoded RelayState — a bare returnUrl here.
    assert record["return_to"] == RETURN_URL
    assert query.get("RelayState", [""])[0] == RETURN_URL


def test_logout_initiate_forwards_name_id(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_logout_module, "OneLogin_Saml2_Auth", _make_logout_auth(record))

    res = client.get(
        "/saml/logout", params=_logout_params(nameId=NAME_ID), follow_redirects=False
    )

    assert res.status_code == 302
    assert record["name_id"] == NAME_ID


def test_logout_initiate_composite_relaystate_when_connection_doc_id(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_logout_module, "OneLogin_Saml2_Auth", _make_logout_auth(record))

    res = client.get(
        "/saml/logout",
        params=_logout_params(connectionDocId="conn-doc-1"),
        follow_redirects=False,
    )

    assert res.status_code == 302
    assert record["return_to"].startswith("mimicrs:")
    assert decode_relay_state(record["return_to"]) == {
        "returnUrl": RETURN_URL,
        "connectionDocId": "conn-doc-1",
    }


def test_logout_initiate_settings_shape_and_request_data_omits_server_port(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_logout_module, "OneLogin_Saml2_Auth", _make_logout_auth(record))

    res = client.get(
        "/saml/logout", params=_logout_params(), headers=FWD_HEADERS, follow_redirects=False
    )

    assert res.status_code == 302
    settings = record["settings"]
    assert settings["security"]["wantMessagesSigned"] is False
    assert settings["sp"]["singleLogoutService"]["url"] == "https://saml-proxy.example.com/saml/sls"
    assert settings["idp"]["singleLogoutService"]["url"] == IDP_SLO_URL
    assert settings["idp"]["singleSignOnService"]["url"] == IDP_SLO_URL
    # server_port DELIBERATELY absent from the SLO request_data (unlike todos 8/9).
    assert "server_port" not in record["request_data"]
    assert record["request_data"] == {
        "https": "on",
        "http_host": "saml-proxy.example.com",
        "script_name": "/saml/sls",
        "get_data": {},
        "post_data": {},
    }


def test_logout_initiate_logout_raises_returns_502(monkeypatch):
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_logout_auth_raising(RuntimeError("kaboom")),
    )

    res = client.get("/saml/logout", params=_logout_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "unexpected: kaboom"}


def test_logout_initiate_saml_error_returns_502(monkeypatch):
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_logout_auth_raising(OneLogin_Saml2_Error("SAML_SINGLE_LOGOUT_NOT_SUPPORTED")),
    )

    res = client.get("/saml/logout", params=_logout_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "SAML_SINGLE_LOGOUT_NOT_SUPPORTED"}


def test_logout_initiate_construction_error_returns_502(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_logout_auth(record, at_construction_error=ValueError("bad settings")),
    )

    res = client.get("/saml/logout", params=_logout_params(), follow_redirects=False)

    assert res.status_code == 502
    assert res.json() == {"error": "bad settings"}


def test_logout_initiate_no_subprocess_is_spawned(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("/saml/logout must build the LogoutRequest in-process, never via subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    monkeypatch.setattr(subprocess, "run", _boom)
    record: dict = {}
    monkeypatch.setattr(saml_logout_module, "OneLogin_Saml2_Auth", _make_logout_auth(record))

    res = client.get("/saml/logout", params=_logout_params(), follow_redirects=False)

    assert res.status_code == 302


# --- GET /saml/sls — the auth.process_slo() process path -----------------------------


def test_sls_process_slo_no_saml_message_returns_200_not_completed():
    # No SAMLResponse/SAMLRequest → early clean error result → 200 HTML fallback
    # (never an HTTP 400). No mock needed: process_saml_logout returns before it would
    # construct the auth object.
    res = client.get("/saml/sls", follow_redirects=False)

    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "Logout not completed" in res.text
    assert "no SAMLResponse or SAMLRequest" in res.text


def test_sls_process_slo_success_returns_200_logged_out(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64"},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "Logged out" in res.text
    assert res.headers.get("location") is None
    # process_slo was called in-process with keep_local_session=True (harness parity).
    assert record["keep_local_session"] is True


def test_sls_process_slo_errors_returns_200_not_completed_with_reason(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_process_auth(
            record,
            errors=["invalid_logout_response"],
            reason="Signature validation failed",
        ),
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64"},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "Logout not completed" in res.text
    assert "invalid_logout_response" in res.text
    assert "Signature validation failed" in res.text


def test_sls_process_slo_raises_returns_200_not_completed(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_process_auth(record, process_error=RuntimeError("boom")),
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "GARBAGE"},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "Logout not completed" in res.text
    assert "malformed SAML logout message: boom" in res.text


def test_sls_process_slo_construction_error_returns_200_not_completed(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_process_auth(record, at_construction_error=ValueError("invalid dict settings")),
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64"},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "Logout not completed" in res.text
    assert "invalid dict settings" in res.text


def test_sls_process_slo_allowlisted_relaystate_redirects_302_logged_out(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64", "RelayState": RETURN_URL},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{RETURN_URL}?samlLogoutStatus=")
    token = location.split("samlLogoutStatus=", 1)[1]
    payload = verify_status(token)
    assert payload is not None
    assert payload["status"] == "logged_out"


def test_sls_process_slo_allowlisted_relaystate_redirects_302_error(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module,
        "OneLogin_Saml2_Auth",
        _make_process_auth(record, errors=["invalid_logout_response"], reason="bad sig"),
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64", "RelayState": RETURN_URL},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{RETURN_URL}?samlLogoutStatus=")
    payload = verify_status(location.split("samlLogoutStatus=", 1)[1])
    assert payload is not None
    assert payload["status"] == "error"
    assert "invalid_logout_response" in str(payload["message"])
    assert "bad sig" in str(payload["message"])


def test_sls_process_slo_disallowed_relaystate_falls_through_to_html(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    res = client.get(
        "/saml/sls",
        params={
            "SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64",
            "RelayState": "https://evil.example.com/callback",
        },
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert res.headers.get("location") is None
    assert "Logged out" in res.text


def test_sls_process_slo_firestore_override_changes_settings(monkeypatch):
    record: dict = {}
    override = {
        "entity_id": "https://override.idp/entity",
        "sso_url": "https://override.idp/sso",
        "slo_url": "https://override.idp/slo",
        "certificate": "OVERRIDE_INLINE_PEM",
    }
    seen: dict = {}

    def _fake_get(connection_doc_id):
        seen["doc_id"] = connection_doc_id
        return override

    monkeypatch.setattr(saml_logout_module, "get_mimic_idp_connection", _fake_get)
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    relay_state = encode_relay_state(
        {"returnUrl": RETURN_URL, "connectionDocId": "conn-override-doc"}
    )
    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64", "RelayState": relay_state},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    # The Firestore override actually drove the settings passed to construction.
    assert seen["doc_id"] == "conn-override-doc"
    idp = record["settings"]["idp"]
    assert idp["entityId"] == "https://override.idp/entity"
    assert idp["singleLogoutService"]["url"] == "https://override.idp/slo"
    assert idp["singleSignOnService"]["url"] == "https://override.idp/slo"
    assert idp["x509cert"] == "OVERRIDE_INLINE_PEM"
    # RelayState returnUrl is allowlisted → 302 with a logged_out token.
    assert res.status_code == 302
    payload = verify_status(res.headers["location"].split("samlLogoutStatus=", 1)[1])
    assert payload is not None
    assert payload["status"] == "logged_out"


def test_sls_process_slo_direct_query_params_win_over_firestore(monkeypatch):
    record: dict = {}
    called: dict = {"hit": False}

    def _fake_get(connection_doc_id):
        called["hit"] = True
        return {"entity_id": "X", "sso_url": "X", "slo_url": "X", "certificate": "X"}

    monkeypatch.setattr(saml_logout_module, "get_mimic_idp_connection", _fake_get)
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    relay_state = encode_relay_state(
        {"returnUrl": RETURN_URL, "connectionDocId": "conn-doc"}
    )
    res = client.get(
        "/saml/sls",
        params={
            "SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64",
            "RelayState": relay_state,
            "idpEntityId": IDP_ENTITY_ID,
            "idpSloUrl": IDP_SLO_URL,
            "idpCert": IDP_CERT,
        },
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    # Direct params present → Firestore lookup is NOT fired (index.ts:845 precedence).
    assert called["hit"] is False
    assert record["settings"]["idp"]["entityId"] == IDP_ENTITY_ID
    assert res.status_code == 302


def test_sls_process_slo_no_subprocess_is_spawned(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("/saml/sls must process the logout in-process, never via subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    monkeypatch.setattr(subprocess, "run", _boom)
    record: dict = {}
    monkeypatch.setattr(
        saml_logout_module, "OneLogin_Saml2_Auth", _make_process_auth(record)
    )

    res = client.get(
        "/saml/sls",
        params={"SAMLResponse": "FAKE_LOGOUT_RESPONSE_B64"},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200


# --- Shared open-redirect guard sanity (reused from request_context) -----------------


def test_is_allowed_relay_state_default_origin(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGIN", raising=False)
    assert is_allowed_relay_state(RETURN_URL) is True
    assert is_allowed_relay_state("https://evil.example.com/x") is False


# --- Real-provider tests (skip when python3-saml is absent) --------------------------


def test_real_provider_logout_initiate_builds_302_in_process():
    if saml_logout_module.OneLogin_Saml2_Auth is None:
        pytest.skip("python3-saml (onelogin) not installed in this interpreter")

    res = client.get(
        "/saml/logout",
        params={
            "idpSloUrl": REAL_IDP_SLO_URL,
            "idpEntityId": REAL_IDP_ENTITY_ID,
            "idpCert": IDP_CERT,
            "returnUrl": RETURN_URL,
        },
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    # The real toolkit built an unsigned LogoutRequest in-process and 302'd to the IdP
    # SLO endpoint carrying SAMLRequest + the RelayState (no subprocess, no crash).
    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{REAL_IDP_SLO_URL}?")
    query = parse_qs(urlsplit(location).query)
    assert query.get("SAMLRequest", [""])[0]
    assert query.get("RelayState", [""])[0] == RETURN_URL


def test_real_provider_sls_process_slo_runs_in_process():
    if saml_logout_module.OneLogin_Saml2_Auth is None:
        pytest.skip("python3-saml (onelogin) not installed in this interpreter")

    # A malformed SAMLResponse (plan QA scenario): the real process_slo runs in-process
    # and collapses to a clean error result — NEVER a raw traceback / 500. With no
    # allowlisted RelayState it renders the 200 "Logout not completed" HTML.
    res = client.get(
        "/saml/sls",
        params={
            "SAMLResponse": "not-a-real-deflated-base64-logout-response",
            "idpSloUrl": REAL_IDP_SLO_URL,
            "idpEntityId": REAL_IDP_ENTITY_ID,
            "idpCert": IDP_CERT,
        },
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "Logout not completed" in res.text
