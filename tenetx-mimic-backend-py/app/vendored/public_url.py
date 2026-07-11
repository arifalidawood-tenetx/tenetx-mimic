# Vendored verbatim from tenetx-source-code-dontpush/tenetx/common/public_url.py
# - do not edit beyond the import-path fix; re-sync manually if the real SAMLProvider
#   changes. Preserves multi-IdP (Okta/Azure AD/Google Workspace/Keycloak/Authentik)
#   attribute-fallback support - see `_extract_user_claims`/`_get_attribute` in the
#   companion vendored module saml_provider.py. This file itself is stdlib-only
#   (ipaddress/re/urllib) and was copied with ZERO edits below.

"""Helpers for constructing safe public origins from request metadata."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse


DEFAULT_PUBLIC_HOST = "tenetx.dev"

_DNS_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_DNS_HOST_RE = re.compile(rf"^{_DNS_LABEL}(?:\.{_DNS_LABEL})*$", re.IGNORECASE)
_BRACKETED_IPV6_RE = re.compile(r"^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$", re.IGNORECASE)
_UNSAFE_HOST_RE = re.compile(r"[\s/\\\"'`$]|[\x00-\x1f\x7f]")


def _valid_port(port: str | None) -> bool:
    if port is None:
        return True
    if not port.isdigit():
        return False
    value = int(port)
    return 1 <= value <= 65535


def _normalize_host_only(host: str) -> str | None:
    if host == "localhost":
        return host
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if address.version == 6:
            return f"[{address.compressed}]"
        return address.compressed
    if len(host) > 253:
        return None
    if not _DNS_HOST_RE.fullmatch(host):
        return None
    return host


def normalize_public_host(host: str, *, default: str = DEFAULT_PUBLIC_HOST) -> str:
    """Return a safe host[:port] value for embedding in public URLs.

    Request hosts can be attacker-controlled when an edge or proxy accepts an
    unexpected Host/X-Forwarded-Host value. Never reflect shell-active,
    whitespace, path-like, or otherwise invalid host data into installer
    scripts, OAuth redirects, SAML metadata, or SCIM resource references.
    """
    candidate = (host or "").split(",", 1)[0].strip().lower()
    if not candidate or _UNSAFE_HOST_RE.search(candidate):
        return default

    if candidate.startswith("["):
        match = _BRACKETED_IPV6_RE.fullmatch(candidate)
        if not match or not _valid_port(match.group(2)):
            return default
        try:
            address = ipaddress.ip_address(match.group(1))
        except ValueError:
            return default
        if address.version != 6:
            return default
        suffix = f":{match.group(2)}" if match.group(2) else ""
        return f"[{address.compressed}]{suffix}"

    if candidate.count(":") >= 2:
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            return default
        if address.version != 6:
            return default
        return f"[{address.compressed}]"

    port: str | None = None
    host_part = candidate
    if ":" in candidate:
        host_part, port = candidate.rsplit(":", 1)
        if not host_part or not _valid_port(port):
            return default

    normalized_host = _normalize_host_only(host_part)
    if normalized_host is None:
        return default
    return f"{normalized_host}:{port}" if port else normalized_host


def is_local_development_host(host: str) -> bool:
    """Return whether a host should default to plain HTTP in local dev."""
    normalized = normalize_public_host(host, default="")
    if not normalized:
        return False
    if normalized == "localhost" or normalized.startswith("localhost:"):
        return True
    if normalized.startswith("["):
        end = normalized.find("]")
        host_only = normalized[1:end] if end != -1 else normalized
    elif normalized.count(":") == 1:
        host_only = normalized.split(":", 1)[0]
    else:
        host_only = normalized
    return host_only in {"127.0.0.1", "::1"}


def normalize_public_scheme(proto: str, *, host: str) -> str:
    """Return http/https for a public origin, defaulting safely when invalid."""
    candidate = (proto or "").split(",", 1)[0].strip().lower()
    if candidate in {"http", "https"}:
        return candidate
    return "http" if is_local_development_host(host) else "https"


def public_origin_from_request_parts(
    *,
    host: str,
    proto: str,
    default_host: str = DEFAULT_PUBLIC_HOST,
) -> str:
    """Build a sanitized scheme://host origin from request-derived parts."""
    safe_host = normalize_public_host(host, default=default_host)
    scheme = normalize_public_scheme(proto, host=safe_host)
    return f"{scheme}://{safe_host}"


def public_origin_from_configured_url(
    value: str,
    *,
    fallback_proto: str,
    default_host: str = DEFAULT_PUBLIC_HOST,
) -> str | None:
    """Return a safe origin from an explicit URL/host config, or None."""
    configured = (value or "").strip()
    if not configured:
        return None

    parsed = urlparse(configured)
    if parsed.scheme and parsed.netloc:
        return public_origin_from_request_parts(
            host=parsed.netloc,
            proto=parsed.scheme,
            default_host=default_host,
        ).rstrip("/")

    if parsed.path:
        base_host = configured.split("/", 1)[0].strip()
        if base_host:
            return public_origin_from_request_parts(
                host=base_host,
                proto=fallback_proto,
                default_host=default_host,
            ).rstrip("/")
    return None
