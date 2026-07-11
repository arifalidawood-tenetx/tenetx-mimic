"""Ported from tenetx-mimic-backend/test/logger.test.ts.

Every assertion in the vitest suite is reproduced 1:1 below (same cases, same
expected values), against the SAME shared config object + pure helpers exported
by ``app.logger`` — never a local copy — so breaking ``REDACT_CONFIG`` /
``resolve_log_level`` / ``should_ignore_health_check`` in ``app/logger.py``
breaks these tests too, exactly as the Node original intends.

Extra cases beyond the 1:1 port (all additive, none loosen the ported ones):
- redaction of ``refreshToken`` (the ``FIREBASE_REFRESH_TOKEN``-shaped secret the
  todo's failure QA scenario calls out) plus a nested auth header and a
  ``*.certificate`` wildcard, locking the full pino path grammar;
- ``silent`` level emits nothing (the NODE_ENV=test behavior);
- the ``RequestIdLoggingMiddleware`` request-id generate/echo/reuse, ``/health``
  log suppression, and query-string stripping — proving it is ready to mount.
"""
from __future__ import annotations

import asyncio
import io
import json
from typing import Any

from app.logger import (
    REDACT_CONFIG,
    RequestIdLoggingMiddleware,
    build_logger,
    log_event,
    resolve_log_level,
    serialize_request,
    should_ignore_health_check,
    strip_query_string,
)


# ---------------------------------------------------------------------------
# resolveLogLevel precedence (logger.test.ts:16-32)
# ---------------------------------------------------------------------------
def test_maps_node_env_test_to_the_silent_level() -> None:
    assert resolve_log_level({"NODE_ENV": "test"}) == "silent"


def test_maps_node_env_production_to_the_info_level() -> None:
    assert resolve_log_level({"NODE_ENV": "production"}) == "info"


def test_defaults_to_debug_when_neither_log_level_nor_known_node_env() -> None:
    assert resolve_log_level({}) == "debug"


def test_lets_an_explicit_log_level_win_over_node_env() -> None:
    assert resolve_log_level({"LOG_LEVEL": "trace", "NODE_ENV": "production"}) == "trace"


# ---------------------------------------------------------------------------
# REDACT_CONFIG redaction (logger.test.ts:34-55) + additive secret coverage
# ---------------------------------------------------------------------------
def _capture_logger(name: str) -> tuple[Any, io.StringIO]:
    """A dedicated in-memory logger forced to ``info`` — the Python analogue of
    the throwaway pino instance wired to a Writable in logger.test.ts:40-47. It
    consumes the REAL ``REDACT_CONFIG`` (via the shared formatter), so this is a
    live test of the shipped config."""
    stream = io.StringIO()
    return build_logger(name=name, level="info", stream=stream), stream


def test_censors_a_secret_bearing_key_and_never_leaks_its_raw_value() -> None:
    log, stream = _capture_logger("redact-certificate")
    log_event(log, "info", "redaction smoke test", {"certificate": "FAKE-PEM-VALUE"})
    output = stream.getvalue()

    assert '"certificate":"[REDACTED]"' in output
    assert "FAKE-PEM-VALUE" not in output


def test_censors_the_refresh_token_secret_key() -> None:
    # `refreshToken` is the REDACT_CONFIG key that scrubs the FIREBASE_REFRESH_TOKEN
    # -shaped secret the todo's failure QA scenario names explicitly.
    log, stream = _capture_logger("redact-refresh-token")
    log_event(log, "info", "auth", {"refreshToken": "1//SUPER-SECRET-REFRESH"})
    output = stream.getvalue()

    assert '"refreshToken":"[REDACTED]"' in output
    assert "SUPER-SECRET-REFRESH" not in output


def test_censors_a_nested_authorization_header() -> None:
    log, stream = _capture_logger("redact-nested-auth")
    log_event(
        log,
        "info",
        "inbound",
        {"req": {"headers": {"authorization": "Bearer LEAKME", "host": "x"}}},
    )
    output = stream.getvalue()

    assert '"authorization":"[REDACTED]"' in output
    assert "LEAKME" not in output
    assert '"host":"x"' in output  # non-secret sibling survives


def test_censors_a_wildcard_certificate_one_level_deep() -> None:
    log, stream = _capture_logger("redact-wildcard-cert")
    log_event(log, "info", "idp", {"connection": {"certificate": "WILDCARD-PEM"}})
    output = stream.getvalue()

    assert '"certificate":"[REDACTED]"' in output
    assert "WILDCARD-PEM" not in output


def test_silent_level_emits_nothing() -> None:
    # NODE_ENV=test resolves to 'silent'; nothing must reach the sink.
    stream = io.StringIO()
    log = build_logger(name="silent-logger", level="silent", stream=stream)
    log_event(log, "info", "should not appear", {"certificate": "X"})

    assert stream.getvalue() == ""


# ---------------------------------------------------------------------------
# shouldIgnoreHealthCheck (logger.test.ts:57-73)
# ---------------------------------------------------------------------------
def test_ignores_the_bare_health_probe_path() -> None:
    assert should_ignore_health_check({"url": "/health"}) is True


def test_does_not_ignore_a_real_saml_route() -> None:
    assert should_ignore_health_check({"url": "/saml/acs"}) is False


def test_does_not_ignore_health_with_a_query_string() -> None:
    # Documented exact-match limitation, asserted as False so any future loosening
    # of the predicate is a visible change (logger.test.ts:66-72).
    assert should_ignore_health_check({"url": "/health?x=1"}) is False


# ---------------------------------------------------------------------------
# stripQueryString (logger.test.ts:75-87)
# ---------------------------------------------------------------------------
def test_drops_everything_from_the_first_question_mark_onward() -> None:
    assert strip_query_string("/saml/login?idpCert=SECRET") == "/saml/login"


def test_is_a_no_op_when_there_is_no_query_string() -> None:
    assert strip_query_string("/health") == "/health"


def test_returns_an_empty_string_for_undefined_input() -> None:
    assert strip_query_string(None) == ""


# ---------------------------------------------------------------------------
# serializeRequest (logger.test.ts:89-107)
# ---------------------------------------------------------------------------
def test_strips_the_query_string_off_req_url_without_dropping_id_method() -> None:
    result = serialize_request(
        {
            "id": "abc123",
            "method": "GET",
            "url": "/saml/sls?SAMLResponse=RAWBODY&idpCert=SECRETPEM",
        }
    )

    assert result["id"] == "abc123"
    assert result["method"] == "GET"
    assert result["url"] == "/saml/sls"
    # No query-string secret survives anywhere in the serialized shape.
    assert "RAWBODY" not in result["url"]
    assert "SECRETPEM" not in result["url"]
    serialized = json.dumps(result)
    assert "RAWBODY" not in serialized
    assert "SECRETPEM" not in serialized


# ---------------------------------------------------------------------------
# RequestIdLoggingMiddleware — the createHttpLogger() equivalent (additive)
# ---------------------------------------------------------------------------
def _http_scope(path: str, query: bytes = b"", method: str = "GET", headers=None) -> dict:
    return {
        "type": "http",
        "path": path,
        "query_string": query,
        "method": method,
        "headers": headers or [],
    }


async def _ok_app(scope, receive, send) -> None:
    await send(
        {"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]}
    )
    await send({"type": "http.response.body", "body": b"ok"})


def _drive(middleware: RequestIdLoggingMiddleware, scope: dict) -> list[dict]:
    """Run the ASGI middleware to completion (no FastAPI needed) and return the
    ASGI messages it sent downstream."""
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    return sent


def _start_headers(sent: list[dict]) -> dict[bytes, bytes]:
    start = next(m for m in sent if m["type"] == "http.response.start")
    return {k.lower(): v for k, v in start["headers"]}


def test_middleware_generates_and_echoes_a_request_id_and_strips_query() -> None:
    log, stream = _capture_logger("mw-generate")
    mw = RequestIdLoggingMiddleware(_ok_app, log)

    sent = _drive(mw, _http_scope("/saml/login", query=b"idpCert=SECRETPEM"))
    headers = _start_headers(sent)

    assert b"x-request-id" in headers  # echoed back on the response
    request_id = headers[b"x-request-id"].decode()
    assert len(request_id) > 0

    output = stream.getvalue()
    assert '"url":"/saml/login"' in output  # query-string stripped in the log
    assert "SECRETPEM" not in output  # secret never logged
    assert request_id in output  # correlation id attached to the line


def test_middleware_reuses_an_inbound_request_id() -> None:
    log, stream = _capture_logger("mw-reuse")
    mw = RequestIdLoggingMiddleware(_ok_app, log)

    sent = _drive(
        mw, _http_scope("/saml/acs", headers=[(b"x-request-id", b"inbound-123")])
    )
    headers = _start_headers(sent)

    assert headers[b"x-request-id"] == b"inbound-123"
    assert "inbound-123" in stream.getvalue()


def test_middleware_suppresses_the_health_check_request_log() -> None:
    log, stream = _capture_logger("mw-health")
    mw = RequestIdLoggingMiddleware(_ok_app, log)

    sent = _drive(mw, _http_scope("/health"))
    headers = _start_headers(sent)

    assert b"x-request-id" in headers  # id still generated + echoed
    assert stream.getvalue() == ""  # but no request-completed log line
