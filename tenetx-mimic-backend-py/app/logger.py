"""Structured JSON logging for the SAML proxy — ported from
tenetx-mimic-backend/src/logger.ts.

Two redaction layers work together, exactly as in the Node original:

  1. ``REDACT_CONFIG`` scrubs secret-bearing object KEYS (certificates, SAML
     assertions, auth headers, refresh tokens) out of any logged payload
     (logger.ts:38-50).
  2. ``serialize_request`` strips the query string off ``req.url`` BEFORE it is
     logged (logger.ts:66-72).

Layer 2 is not optional: key-based redaction only matches known object keys, so
a secret sitting inside a URL string (e.g. ``/saml/login?idpCert=<PEM>``) is
invisible to it. ``/saml/login``, ``/saml/logout``, and ``/saml/sls`` all accept
a certificate / SAMLResponse as a query param, so without the custom serializer
the default request log would leak those secrets in plaintext at the ``info``
level (logger.ts:14-19).

Implementation choice: stdlib ``logging`` + a compact JSON formatter (not
structlog), so this module has ZERO third-party imports. That keeps ``app.logger``
importable — and ``app/test/test_logger.py`` runnable — without FastAPI/Starlette
installed, and lets the request-id middleware be a pure-ASGI callable that still
mounts cleanly via ``app.add_middleware`` (see ``RequestIdLoggingMiddleware``).
The pure helpers keep the SAME names/semantics as logger.ts so the pytest suite
mirrors logger.test.ts one-to-one.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import sys
import uuid
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, MutableMapping, Optional
from typing import Mapping as TMapping

__all__ = [
    "resolve_log_level",
    "REDACT_CONFIG",
    "should_ignore_health_check",
    "strip_query_string",
    "serialize_request",
    "apply_redaction",
    "LOG_LEVEL_MAP",
    "level_name_to_number",
    "JsonLogFormatter",
    "build_logger",
    "log_event",
    "debug_saml_xml",
    "logger",
    "request_id_var",
    "get_request_id",
    "generate_request_id",
    "RequestIdLoggingMiddleware",
]


# ---------------------------------------------------------------------------
# Pure helpers (direct 1:1 ports of the logger.ts named exports)
# ---------------------------------------------------------------------------
def resolve_log_level(env: Optional[TMapping[str, str]] = None) -> str:
    """Resolve the pino-vocabulary log level. Port of logger.ts:23-32.

    Pure so tests can pass a fabricated env mapping instead of mutating the real
    ``os.environ``. Precedence: explicit ``LOG_LEVEL`` > ``NODE_ENV``-derived
    default (``test`` -> ``silent``, ``production`` -> ``info``, else ``debug``).
    JS ``env.LOG_LEVEL ||`` treats ``''`` as falsy; ``env.get("LOG_LEVEL") or``
    is the exact Python equivalent.
    """
    if env is None:
        env = os.environ
    explicit = env.get("LOG_LEVEL")
    if explicit:
        return explicit
    node_env = env.get("NODE_ENV")
    if node_env == "test":
        return "silent"
    if node_env == "production":
        return "info"
    return "debug"


# Exact copy of logger.ts:38-50's REDACT_CONFIG. The key list must NOT drift from
# the Node original: the redaction test drives a dedicated logger off this SAME
# object, so breaking this config breaks the test too.
REDACT_CONFIG: dict[str, Any] = {
    "paths": [
        "req.headers.authorization",
        "req.headers.cookie",
        "certificate",
        "*.certificate",
        "idpCert",
        "*.idpCert",
        "samlResponse",
        "refreshToken",
    ],
    "censor": "[REDACTED]",
}


def should_ignore_health_check(req: TMapping[str, Any]) -> bool:
    """Port of logger.ts:54-56. Exact-string match on ``/health`` so the health
    poll noise stays out of the request log. Query-suffixed ``/health?x=1`` is a
    documented non-match (asserted in the tests)."""
    return req.get("url") == "/health"


def strip_query_string(url: Optional[str]) -> str:
    """Port of logger.ts:60-62. Drop everything from the first ``?`` onward so
    query-string secrets never reach the log sink; ``''`` for a missing url."""
    return url.split("?")[0] if url else ""


def serialize_request(req: TMapping[str, Any]) -> dict[str, Any]:
    """Port of logger.ts:66-72. Replaces the default request serializer that would
    otherwise log the full, query-string-intact URL."""
    return {
        "id": req.get("id"),
        "method": req.get("method"),
        "url": strip_query_string(req.get("url")),
    }


# ---------------------------------------------------------------------------
# Redaction engine (the Python equivalent of pino's built-in ``redact``)
# ---------------------------------------------------------------------------
def _redact_path(node: Any, segments: list[str], censor: str) -> None:
    """Censor one pino redaction path in-place. Supports the two path shapes the
    config uses: dotted nested paths (``req.headers.authorization``) and a single
    wildcard segment (``*.certificate`` = ``certificate`` one level under any key)."""
    if not isinstance(node, MutableMapping):
        return
    head, rest = segments[0], segments[1:]
    if not rest:  # leaf segment
        if head == "*":
            for key in list(node.keys()):
                node[key] = censor
        elif head in node:
            node[head] = censor
        return
    if head == "*":
        for value in node.values():
            _redact_path(value, rest, censor)
    else:
        child = node.get(head)
        if isinstance(child, MutableMapping):
            _redact_path(child, rest, censor)


def apply_redaction(
    payload: TMapping[str, Any], config: TMapping[str, Any] = REDACT_CONFIG
) -> dict[str, Any]:
    """Return a redacted deep copy of ``payload`` per ``config['paths']``. Never
    mutates the caller's object, mirroring pino redacting on the way to the sink."""
    redacted = copy.deepcopy(dict(payload))
    censor = config["censor"]
    for path in config["paths"]:
        _redact_path(redacted, path.split("."), censor)
    return redacted


# ---------------------------------------------------------------------------
# Level mapping (pino level names -> stdlib logging numeric levels)
# ---------------------------------------------------------------------------
TRACE_LEVEL = 5  # below DEBUG(10), matching pino's trace < debug ordering
SILENT_LEVEL = logging.CRITICAL + 10  # 60 — above every real level == no output
logging.addLevelName(TRACE_LEVEL, "trace")

LOG_LEVEL_MAP: dict[str, int] = {
    "silent": SILENT_LEVEL,
    "trace": TRACE_LEVEL,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "fatal": logging.CRITICAL,
}


def level_name_to_number(level_name: str) -> int:
    """Map a pino level name to a stdlib numeric level (unknown -> INFO)."""
    return LOG_LEVEL_MAP.get(level_name, logging.INFO)


# ---------------------------------------------------------------------------
# Request-id correlation (the pino-http genReqId equivalent, logger.ts:110-117)
# ---------------------------------------------------------------------------
request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)


def get_request_id() -> Optional[str]:
    """Current request's correlation id (bound by the middleware), or ``None``."""
    return request_id_var.get()


def generate_request_id(existing: Optional[str] = None) -> str:
    """Reuse an inbound ``X-Request-Id`` when present, else mint a fresh UUID —
    the Python equivalent of logger.ts:110-114's ``existing || randomUUID()``."""
    return existing or str(uuid.uuid4())


# ---------------------------------------------------------------------------
# JSON logger
# ---------------------------------------------------------------------------
class JsonLogFormatter(logging.Formatter):
    """Render each record as ONE compact JSON line, with secret redaction.

    A structured payload dict is passed via ``extra={"payload": {...}}`` and is
    merged into the log object AFTER redaction — the stdlib-logging analogue of
    pino's ``redact``. The active correlation id (from ``request_id_var``) is
    attached as ``req_id`` so every line inside a request is correlated. Compact
    separators mirror pino's spaceless JSON (``"certificate":"[REDACTED]"``).
    """

    def format(self, record: logging.LogRecord) -> str:
        log_object: dict[str, Any] = {
            "level": record.levelname,
            "time": int(record.created * 1000),
            "msg": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id is not None:
            log_object["req_id"] = request_id
        payload = getattr(record, "payload", None)
        if isinstance(payload, TMapping):
            for key, value in apply_redaction(payload).items():
                log_object[key] = value
        if record.exc_info:
            log_object["err"] = self.formatException(record.exc_info)
        return json.dumps(log_object, separators=(",", ":"), default=str)


def build_logger(
    name: str = "tenetx.mimic",
    level: Optional[str] = None,
    stream: Optional[Any] = None,
) -> logging.Logger:
    """Build an isolated JSON logger — the pino-factory analogue.

    A pino ``level`` name + a target stream. ``propagate=False`` and a fresh
    handler per call keep instances isolated (repeated ``build_logger(name=...)``
    calls do not stack sinks), matching logger.test.ts's dedicated in-memory pino
    instance. ``level`` defaults to :func:`resolve_log_level`; ``stream`` to
    stdout (where pino writes by default).
    """
    resolved = level if level is not None else resolve_log_level()
    numeric = level_name_to_number(resolved)
    instance = logging.getLogger(name)
    instance.setLevel(numeric)
    instance.propagate = False
    for existing_handler in list(instance.handlers):
        instance.removeHandler(existing_handler)
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setLevel(numeric)
    handler.setFormatter(JsonLogFormatter())
    instance.addHandler(handler)
    return instance


def log_event(
    instance: logging.Logger,
    level_name: str,
    msg: str,
    payload: Optional[TMapping[str, Any]] = None,
) -> None:
    """Emit a structured record. ``payload`` (a dict) is redacted by the formatter
    before serialization — mirrors pino's ``log.<level>({...payload}, 'msg')``."""
    numeric = level_name_to_number(level_name)
    extra = {"payload": dict(payload)} if payload else None
    instance.log(numeric, msg, extra=extra)


def debug_saml_xml(
    instance: logging.Logger, msg: str, xml: str, **context: Any
) -> None:
    """``LOG_LEVEL``-gated SAML XML dump.

    Full request/response XML is only emitted when the logger is enabled for
    DEBUG (i.e. ``LOG_LEVEL`` is ``debug`` or ``trace``), keeping large,
    assertion-bearing XML out of info/production logs. The Node side relies on
    pino suppressing ``logger.debug(xml)`` below its level; this makes the same
    gate explicit and cheap (no serialization work when disabled).
    """
    if not instance.isEnabledFor(logging.DEBUG):
        return
    payload = dict(context)
    payload["saml_xml"] = xml
    log_event(instance, "debug", msg, payload)


# Shared module logger (logger.ts:85-100's ``export const logger``): level from
# LOG_LEVEL, JSON to stdout. Name mirrors the monorepo "tenetx.<service>" scheme.
logger = build_logger("tenetx.mimic")


# ---------------------------------------------------------------------------
# Request-id + request-logging middleware (the createHttpLogger() equivalent)
# ---------------------------------------------------------------------------
Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[TMapping[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def _header_value(headers: Any, name: bytes) -> Optional[str]:
    """First value of a raw ASGI header (list of ``(bytes, bytes)``), or ``None``."""
    for key, value in headers or []:
        if key.lower() == name:
            return value.decode("latin-1") if isinstance(value, bytes) else str(value)
    return None


class RequestIdLoggingMiddleware:
    """Pure-ASGI middleware — the FastAPI-mountable equivalent of
    ``createHttpLogger()`` (logger.ts:105-121).

    Deliberately depends on NOTHING but the stdlib + this module, so importing
    ``app.logger`` never requires FastAPI/Starlette. Mount it as the OUTERMOST
    middleware, exactly as index.ts:25 mounts ``createHttpLogger()`` FIRST so it
    wraps every request (incl. CORS-rejected/malformed). Because Starlette makes
    the LAST-added middleware outermost, add it AFTER ``CORSMiddleware``::

        from app.logger import RequestIdLoggingMiddleware
        app.add_middleware(CORSMiddleware, ...)
        app.add_middleware(RequestIdLoggingMiddleware)   # outermost

    Behavior parity with pino-http + genReqId:
      * reuses an inbound ``X-Request-Id`` when present, else a fresh UUID
        (logger.ts:110-114);
      * echoes it back on the response ``X-Request-Id`` header (logger.ts:115);
      * binds it to ``request_id_var`` so every log line in the request correlates;
      * skips auto-logging for ``/health`` (``should_ignore_health_check``,
        logger.ts:118);
      * logs the query-string-stripped url (``serialize_request``, logger.ts:119),
        never the raw one.
    """

    def __init__(self, app: ASGIApp, instance: Optional[logging.Logger] = None) -> None:
        self.app = app
        self.logger = instance if instance is not None else logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        inbound_id = _header_value(scope.get("headers"), b"x-request-id")
        request_id = generate_request_id(inbound_id)
        token = request_id_var.set(request_id)

        path = scope.get("path", "")
        query = scope.get("query_string", b"") or b""
        full_url = f"{path}?{query.decode('latin-1')}" if query else path
        method = scope.get("method")
        ignore = should_ignore_health_check({"url": path})
        status_holder: dict[str, int] = {}

        async def send_wrapper(message: TMapping[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                mutable = dict(message)
                headers = [
                    (k, v)
                    for (k, v) in (mutable.get("headers") or [])
                    if k.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                mutable["headers"] = headers
                status_holder["status"] = int(mutable.get("status", 0))
                await send(mutable)
                return
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if not ignore:
                log_event(
                    self.logger,
                    "info",
                    "request completed",
                    {
                        "req": serialize_request(
                            {"id": request_id, "method": method, "url": full_url}
                        ),
                        "res": {"statusCode": status_holder.get("status")},
                    },
                )
            request_id_var.reset(token)
