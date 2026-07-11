"""Tests for POST /saml/acs — the in-process SAML ACS validation route (todo 9).

Ports the vitest assertions in ``tenetx-mimic-backend/test/acs.test.ts`` (capture +
400) and ``test/acs-validate.test.ts`` (validated/rejected HTML, RelayState 302
with a signed samlStatus token, the open-redirect guard, and the Firestore
per-tester override) plus error-shape, request-shape, and no-subprocess coverage.

DUAL-INTERPRETER STRATEGY (todo 8's established pattern): the mocked cases patch
``app.routes.saml_acs.SAMLProvider`` so they run on ANY interpreter, even one
without ``python3-saml``. The single ``test_real_provider_*`` case drives the REAL
vendored provider in-process and SKIPS when ``onelogin`` is absent — so the suite is
green on the hermes venv (no onelogin) and additionally proves the real strict
``parse_and_validate_response`` runs (and correctly REJECTS an unsigned synthetic
response under ``strict: True`` / ``wantMessagesSigned: True``) on the reference
venv (``tenetx-source-code-dontpush/.venv``).

The SAML fixtures are SELF-CONTAINED (built inline), not read from
``tenetx-mimic-backend/.captured/``: todo 15 renames this package and would break a
test that reached into the Node dir (same reasoning todo 4 used for its fixtures).
"""
from __future__ import annotations

import base64
import os
import re
import subprocess

import pytest

pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.relay_state import encode_relay_state  # noqa: E402
from app.request_context import escape_html, is_allowed_relay_state  # noqa: E402
from app.routes import saml_acs as saml_acs_module  # noqa: E402
from app.status_token import verify_status  # noqa: E402
from app.vendored.saml_provider import (  # noqa: E402
    SAMLConfigurationError,
    SAMLValidationError,
)

client = TestClient(app)

_DEST_HOST = "mimic.example.test"
FWD_HEADERS = {"X-Forwarded-Host": _DEST_HOST, "X-Forwarded-Proto": "https"}

RELAY_ORIGIN = "https://tenetx-mimic.web.app"
RELAY_URL = f"{RELAY_ORIGIN}/mimic/TEN-1/try-it-out"

# A minimal, syntactically-plausible SAML Response. The <saml:Issuer> matches the
# synthetic default entity_id so IdP-issuer validation passes and the unsigned
# rejection is the deterministic failure. Destination host == FWD_HEADERS host so
# the derived ACS matches (no host-divergence rejection masks the "not signed" one).
_ISSUER = saml_acs_module._DEFAULT_ENTITY_ID
SYNTHETIC_SAML_XML = (
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
    'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" '
    'ID="_resp1" Version="2.0" IssueInstant="2099-01-01T00:00:00Z" '
    f'Destination="https://{_DEST_HOST}/saml/acs">'
    f"<saml:Issuer>{_ISSUER}</saml:Issuer>"
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    '<saml:Assertion ID="_a1" Version="2.0" IssueInstant="2099-01-01T00:00:00Z">'
    f"<saml:Issuer>{_ISSUER}</saml:Issuer>"
    '<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">'
    "qa-saml-tester@example.test</saml:NameID></saml:Subject>"
    "</saml:Assertion></samlp:Response>"
)
SYNTHETIC_SAML_B64 = base64.b64encode(SYNTHETIC_SAML_XML.encode("utf-8")).decode("ascii")

_NO_DESTINATION_XML = (
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
    'ID="_resp2" Version="2.0" IssueInstant="2099-01-01T00:00:00Z">'
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    "</samlp:Response>"
)
NO_DESTINATION_B64 = base64.b64encode(_NO_DESTINATION_XML.encode("utf-8")).decode("ascii")


@pytest.fixture(autouse=True)
def _isolate_capture_and_env(tmp_path, monkeypatch):
    """Give every test an isolated capture dir and a clean IdP/allowlist env, so no
    test pollutes the real ``.captured/`` or leaks MIMIC_IDP_* / ALLOWED_ORIGIN."""
    monkeypatch.setenv("MIMIC_CAPTURED_DIR", str(tmp_path / "captured"))
    monkeypatch.delenv("MIMIC_IDP_ENTITY_ID", raising=False)
    monkeypatch.delenv("MIMIC_IDP_SSO_URL", raising=False)
    monkeypatch.delenv("MIMIC_IDP_CERT_FILE", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN", raising=False)


class _FakeAssertion:
    def __init__(self, email: str, name_id: str) -> None:
        self.email = email
        self.name_id = name_id


def _make_validated_provider(
    record: dict, *, email: str = "qa-saml-tester@example.test", name_id: str = "qa-saml-tester@example.test"
) -> type:
    """A fake SAMLProvider that records its construction args + returns a validated
    assertion, so branch/idp_config assertions work without the real onelogin dep."""

    class _P:
        def __init__(self, idp_config, org_slug, sp_base_url):
            record["idp_config"] = idp_config
            record["org_slug"] = org_slug
            record["sp_base_url"] = sp_base_url

        def parse_and_validate_response(self, saml_response_b64, request_data):
            record["saml_response_b64"] = saml_response_b64
            record["request_data"] = request_data
            return _FakeAssertion(email, name_id)

    return _P


def _make_rejected_provider(reason: str) -> type:
    class _P:
        def __init__(self, idp_config, org_slug, sp_base_url):
            pass

        def parse_and_validate_response(self, saml_response_b64, request_data):
            raise SAMLValidationError(reason)

    return _P


def _make_config_error_provider(message: str) -> type:
    class _P:
        def __init__(self, idp_config, org_slug, sp_base_url):
            raise SAMLConfigurationError(message)

    return _P


def test_missing_saml_response_returns_400():
    res = client.post("/saml/acs", data={}, follow_redirects=False)

    assert res.status_code == 400
    assert "application/json" in res.headers.get("content-type", "")
    assert res.json() == {"error": "SAMLResponse is required"}


def test_empty_saml_response_returns_400():
    res = client.post("/saml/acs", data={"SAMLResponse": ""}, follow_redirects=False)

    assert res.status_code == 400
    assert res.json() == {"error": "SAMLResponse is required"}


def test_capture_persist_failure_returns_500(monkeypatch):
    def _boom(*args, **kwargs):
        raise OSError("disk is full")

    monkeypatch.setattr(saml_acs_module.os, "makedirs", _boom)

    res = client.post(
        "/saml/acs", data={"SAMLResponse": SYNTHETIC_SAML_B64}, follow_redirects=False
    )

    assert res.status_code == 500
    assert res.json() == {"error": "failed to persist SAMLResponse"}


def test_valid_response_captures_one_file_and_returns_200(tmp_path, monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    res = client.post(
        "/saml/acs", data={"SAMLResponse": SYNTHETIC_SAML_B64}, follow_redirects=False
    )

    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "captured" in res.text
    captured_dir = tmp_path / "captured"
    written = list(captured_dir.iterdir())
    assert len(written) == 1
    assert written[0].name.startswith("saml-response-")
    assert SYNTHETIC_SAML_B64 in written[0].read_text(encoding="utf-8")


def test_validated_without_relaystate_returns_200_login_succeeded(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_acs_module,
        "SAMLProvider",
        _make_validated_provider(record, email="alice@tenetx.ai"),
    )

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "text/html" in res.headers.get("content-type", "")
    assert "Login succeeded" in res.text
    assert "<strong>alice@tenetx.ai</strong>" in res.text
    assert res.headers.get("location") is None


def test_rejected_without_relaystate_returns_401_login_rejected(monkeypatch):
    reason = "SAML validation failed: invalid_response | Reason: The message of the Response is not signed"
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_rejected_provider(reason))

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 401
    assert "text/html" in res.headers.get("content-type", "")
    assert "Login rejected" in res.text
    assert "not signed" in res.text


def test_config_error_without_relaystate_returns_200_captured(monkeypatch):
    monkeypatch.setattr(
        saml_acs_module, "SAMLProvider", _make_config_error_provider("bad IdP metadata")
    )

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "did not reach a verdict" in res.text
    assert "bad IdP metadata" in res.text


def test_inconclusive_when_destination_missing_returns_200_captured():
    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": NO_DESTINATION_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert "did not reach a verdict" in res.text


def test_validated_with_allowlisted_relaystate_redirects_302_status_validated(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(
        saml_acs_module,
        "SAMLProvider",
        _make_validated_provider(record, email="alice@tenetx.ai"),
    )

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64, "RelayState": RELAY_URL},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{RELAY_URL}?samlStatus=")
    token = location.split("samlStatus=", 1)[1]
    payload = verify_status(token)
    assert payload is not None
    assert payload["status"] == "validated"
    assert payload["email"] == "alice@tenetx.ai"
    assert payload["reason"] is None


def test_rejected_with_allowlisted_relaystate_redirects_302_status_rejected(monkeypatch):
    reason = "SAML validation failed: invalid_response | Reason: The message of the Response is not signed"
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_rejected_provider(reason))

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64, "RelayState": RELAY_URL},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 302
    location = res.headers.get("location", "")
    assert location.startswith(f"{RELAY_URL}?samlStatus=")
    payload = verify_status(location.split("samlStatus=", 1)[1])
    assert payload is not None
    assert payload["status"] == "rejected"
    assert "not signed" in str(payload["reason"]).lower()
    assert payload["email"] is None


def test_relaystate_disallowed_origin_falls_through_to_html(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    res = client.post(
        "/saml/acs",
        data={
            "SAMLResponse": SYNTHETIC_SAML_B64,
            "RelayState": "https://evil.example.com/callback",
        },
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert res.headers.get("location") is None
    assert "Login succeeded" in res.text


def test_firestore_override_changes_idp_config_and_redirects(monkeypatch):
    record: dict = {}
    override = {
        "entity_id": "https://override.idp/entity",
        "sso_url": "https://override.idp/sso",
        "slo_url": "",
        "certificate": "OVERRIDE_INLINE_PEM",
    }
    seen: dict = {}

    def _fake_get(connection_doc_id):
        seen["doc_id"] = connection_doc_id
        return override

    monkeypatch.setattr(saml_acs_module, "get_mimic_idp_connection", _fake_get)
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    relay_state = encode_relay_state(
        {"returnUrl": RELAY_URL, "connectionDocId": "conn-override-doc"}
    )
    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64, "RelayState": relay_state},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert seen["doc_id"] == "conn-override-doc"
    assert record["idp_config"]["saml_entity_id"] == "https://override.idp/entity"
    assert record["idp_config"]["saml_sso_url"] == "https://override.idp/sso"
    assert record["idp_config"]["saml_certificate"] == "OVERRIDE_INLINE_PEM"
    assert res.status_code == 302
    payload = verify_status(res.headers["location"].split("samlStatus=", 1)[1])
    assert payload is not None
    assert payload["status"] == "validated"


def test_firestore_miss_falls_back_to_env_identity(monkeypatch):
    record: dict = {}
    seen: dict = {}

    def _fake_get(connection_doc_id):
        seen["doc_id"] = connection_doc_id
        return None

    monkeypatch.setattr(saml_acs_module, "get_mimic_idp_connection", _fake_get)
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    relay_state = encode_relay_state(
        {"returnUrl": RELAY_URL, "connectionDocId": "conn-missing-doc"}
    )
    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64, "RelayState": relay_state},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert seen["doc_id"] == "conn-missing-doc"
    # No override + no MIMIC_IDP_* env vars -> the synthetic default identity.
    assert record["idp_config"]["saml_entity_id"] == saml_acs_module._DEFAULT_ENTITY_ID
    assert record["idp_config"]["saml_sso_url"] == saml_acs_module._DEFAULT_SSO_URL
    assert res.status_code == 302


def test_request_data_and_idp_config_shapes_match_harness(monkeypatch):
    record: dict = {}
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200
    assert record["org_slug"] == "mimic-harness"
    assert record["sp_base_url"] == f"https://{_DEST_HOST}"
    assert record["request_data"] == {
        "https": "on",
        "http_host": _DEST_HOST,
        "script_name": "/saml/acs",
        "server_port": 443,
        "get_data": {},
        "post_data": {"SAMLResponse": SYNTHETIC_SAML_B64},
    }
    assert record["idp_config"]["saml_acs_url"] == f"https://{_DEST_HOST}/saml/acs"


def test_no_subprocess_is_spawned_by_the_route(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("/saml/acs must validate in-process, never via subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    monkeypatch.setattr(subprocess, "run", _boom)
    record: dict = {}
    monkeypatch.setattr(saml_acs_module, "SAMLProvider", _make_validated_provider(record))

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    assert res.status_code == 200


def test_x_request_id_header_present_on_400():
    res = client.post("/saml/acs", data={}, follow_redirects=False)

    assert res.status_code == 400
    assert re.match(r"^[0-9a-f-]{36}$", res.headers.get("x-request-id", ""))


def test_real_provider_rejects_unsigned_response_in_process():
    import app.vendored.saml_provider as vendored

    if vendored.OneLogin_Saml2_Auth is None:
        pytest.skip("python3-saml (onelogin) not installed in this interpreter")

    res = client.post(
        "/saml/acs",
        data={"SAMLResponse": SYNTHETIC_SAML_B64},
        headers=FWD_HEADERS,
        follow_redirects=False,
    )

    # strict:True / wantMessagesSigned:True correctly REJECTS the unsigned synthetic
    # response — a real in-process verdict, proving the provider ran (not a crash).
    assert res.status_code == 401
    assert "Login rejected" in res.text


def test_is_allowed_relay_state_guard(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGIN", raising=False)
    assert is_allowed_relay_state("https://tenetx-mimic.web.app/mimic/x") is True
    assert is_allowed_relay_state("https://evil.example.com/callback") is False
    assert is_allowed_relay_state("not-a-url") is False
    assert is_allowed_relay_state("") is False
    monkeypatch.setenv("ALLOWED_ORIGIN", "https://custom.host")
    assert is_allowed_relay_state("https://custom.host/path") is True
    assert is_allowed_relay_state("https://tenetx-mimic.web.app/x") is False


def test_escape_html_orders_ampersand_first():
    assert escape_html('<a href="x">&') == "&lt;a href=&quot;x&quot;&gt;&amp;"
    assert escape_html("plain") == "plain"
