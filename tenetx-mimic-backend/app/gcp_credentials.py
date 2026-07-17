"""Unified Google credentials factory — Keycloak OIDC + GCP Workload Identity
Federation (WIF), keyless.

This module is the single source of Google credentials for the backend's raw
``google.cloud.firestore.Client`` (MCP PAT verifier + ``mimic_idp_connections``
lookup) and Firebase Admin init. It REPLACES the legacy
``FIREBASE_REFRESH_TOKEN`` / ``authorized_user`` path: org policy
(``constraints/iam.disableServiceAccountKeyCreation``) blocks minting downloadable
service-account keys AND long-lived refresh tokens, so we federate the existing
Keycloak OIDC provider into GCP instead.

The flow (locked, pure-Python — no subprocess, no
``GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES``):

  1. :class:`_KeycloakSubjectTokenSupplier` fetches a Keycloak access token via the
     ``client_credentials`` grant (in-process ``urllib``, bounded timeout).
  2. :class:`google.auth.identity_pool.Credentials` is built with that supplier as
     its ``subject_token_supplier`` — google-auth exchanges the Keycloak JWT at
     Google STS and (optionally) impersonates a service account, yielding
     short-lived Google access tokens. No key file is ever read or stored.

Fail-closed by construction: :func:`get_google_credentials` returns ``None`` (after
a structured ``warn``) whenever Keycloak client_credentials OR the WIF audience are
unconfigured, so every downstream Firestore/Admin consumer degrades to its existing
"no credentials" posture rather than raising.

NEVER logs secret or token bodies. Keycloak client secret and the minted access
token never appear in a log line or an exception message (only error *type* names
are surfaced).

Environment (all optional; absence => fail-closed ``None``):

  Keycloak (subject-token mint):
    * ``KEYCLOAK_TOKEN_URL``    — full token endpoint, OR
    * ``KEYCLOAK_ISSUER``       — realm base; ``/protocol/openid-connect/token`` appended
    * ``KEYCLOAK_CLIENT_ID``    — confidential client id (client_credentials)
    * ``KEYCLOAK_CLIENT_SECRET``— confidential client secret (never logged)

  WIF (STS exchange target) — from env, or a NON-SECRET ``external_account`` config
  JSON at ``GCP_WIF_CREDENTIAL_CONFIG`` / ``GOOGLE_APPLICATION_CREDENTIALS``
  (``type: external_account`` only; any file containing ``private_key`` is refused):
    * ``GCP_WIF_AUDIENCE``                          — STS audience (WIF provider resource)
    * ``GCP_WIF_STS_TOKEN_URL``                     — STS endpoint (default sts.googleapis.com)
    * ``GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL`` — optional impersonation target
    * ``GCP_WIF_SUBJECT_TOKEN_TYPE``                — default ``...:token-type:jwt``

  Project:
    * ``GCP_PROJECT_ID`` (else ``FIREBASE_PROJECT_ID`` env, else ``tenetx-qa-scores``)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

import google.auth.credentials
from google.auth import exceptions as google_auth_exceptions
from google.auth import identity_pool

from app.logger import log_event, logger

__all__ = ["get_google_credentials", "get_project_id"]

_DEFAULT_PROJECT_ID = "tenetx-qa-scores"
_DEFAULT_STS_TOKEN_URL = "https://sts.googleapis.com/v1/token"
_DEFAULT_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt"
_KEYCLOAK_TOKEN_PATH = "/protocol/openid-connect/token"
_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_HTTP_TIMEOUT_SECONDS = 10.0

# Memoized on the FIRST successful build only. A None (unconfigured) outcome is NOT
# cached, so re-checking env after configuration lands rebuilds. Tests reset this via
# ``monkeypatch.setattr(gcp_credentials, "_credentials_singleton", None)``.
_credentials_singleton: Optional[google.auth.credentials.Credentials] = None


def get_project_id() -> str:
    """Return the GCP project id: ``GCP_PROJECT_ID`` else ``FIREBASE_PROJECT_ID``
    (env) else ``tenetx-qa-scores`` — the project all Firestore clients target."""
    return (
        os.environ.get("GCP_PROJECT_ID")
        or os.environ.get("FIREBASE_PROJECT_ID")
        or _DEFAULT_PROJECT_ID
    )


def _keycloak_token_url() -> Optional[str]:
    """Resolve the Keycloak token endpoint from ``KEYCLOAK_TOKEN_URL`` or derive it
    from ``KEYCLOAK_ISSUER`` + ``/protocol/openid-connect/token``; ``None`` if neither."""
    explicit = os.environ.get("KEYCLOAK_TOKEN_URL")
    if explicit:
        return explicit
    issuer = os.environ.get("KEYCLOAK_ISSUER")
    if issuer:
        return issuer.rstrip("/") + _KEYCLOAK_TOKEN_PATH
    return None


class _KeycloakSubjectTokenSupplier(identity_pool.SubjectTokenSupplier):
    """Supplies a Keycloak access token (subject token) via the ``client_credentials``
    grant, for exchange at Google STS. google-auth does NOT cache the subject token,
    but each STS exchange mints a fresh one on demand — acceptable for this workload.

    The client secret and the minted token are NEVER logged; retrieval errors are
    surfaced as ``RefreshError`` carrying only an error *type* name.
    """

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        timeout: float = _HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._timeout = timeout

    def get_subject_token(self, context: Any, request: Any) -> str:  # noqa: ARG002 — google-auth SubjectTokenSupplier API
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            }
        ).encode("utf-8")
        req = urllib.request.Request(  # noqa: S310 — token_url is operator-configured HTTPS, not user input
            self._token_url,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            # Only the error TYPE name — never the response body (may echo secrets).
            raise google_auth_exceptions.RefreshError(
                f"Keycloak client_credentials request failed: {type(err).__name__}"
            ) from err
        access_token = payload.get("access_token") if isinstance(payload, dict) else None
        if not isinstance(access_token, str) or not access_token:
            raise google_auth_exceptions.RefreshError(
                "Keycloak token response missing access_token"
            )
        return access_token


def _load_external_account_config() -> Optional[dict[str, Any]]:
    """Load a NON-SECRET ``external_account`` cred-config JSON from
    ``GCP_WIF_CREDENTIAL_CONFIG`` or ``GOOGLE_APPLICATION_CREDENTIALS``.

    Returns ``None`` (with a ``warn``) when the path is unset, unreadable, not an
    ``external_account`` config, or contains a ``private_key`` (a service-account key
    file — refused outright; keyless is the whole point). ``credential_source`` in
    the file is ignored — the in-process Keycloak supplier drives the subject token.
    """
    path = os.environ.get("GCP_WIF_CREDENTIAL_CONFIG") or os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
        config = json.loads(raw)
    except (OSError, ValueError) as err:
        log_event(
            logger,
            "warn",
            "gcp_credentials: failed to read WIF credential config; ignoring file.",
            {"err": type(err).__name__},
        )
        return None
    if not isinstance(config, dict):
        return None
    if "private_key" in raw or config.get("type") != "external_account":
        log_event(
            logger,
            "warn",
            "gcp_credentials: credential config is not a keyless external_account; "
            "refusing (no service-account private keys).",
        )
        return None
    return config


def _wif_params() -> Optional[dict[str, Any]]:
    """Resolve WIF STS-exchange fields from env (preferred) then a config JSON.
    Returns ``None`` when no audience is available (WIF cannot work without one)."""
    config = _load_external_account_config() or {}
    audience = os.environ.get("GCP_WIF_AUDIENCE") or config.get("audience")
    if not audience:
        return None
    return {
        "audience": audience,
        "subject_token_type": (
            os.environ.get("GCP_WIF_SUBJECT_TOKEN_TYPE")
            or config.get("subject_token_type")
            or _DEFAULT_SUBJECT_TOKEN_TYPE
        ),
        "token_url": (
            os.environ.get("GCP_WIF_STS_TOKEN_URL")
            or config.get("token_url")
            or _DEFAULT_STS_TOKEN_URL
        ),
        "service_account_impersonation_url": (
            os.environ.get("GCP_WIF_SERVICE_ACCOUNT_IMPERSONATION_URL")
            or config.get("service_account_impersonation_url")
        ),
    }


def get_google_credentials() -> Optional[google.auth.credentials.Credentials]:
    """Return memoized WIF-backed Google credentials, or ``None`` when unconfigured.

    Fail-closed: returns ``None`` (after a ``warn``, never raising) when Keycloak
    ``client_credentials`` env OR the WIF audience are missing, so downstream
    Firestore/Admin consumers degrade to their existing "no credentials" posture.
    NEVER logs the Keycloak client secret or any minted token.

    Construction does NO network I/O — the Keycloak token is minted lazily on the
    first STS exchange (i.e. first Firestore/Admin API call), then re-minted per
    refresh by the supplier.
    """
    global _credentials_singleton
    if _credentials_singleton is not None:
        return _credentials_singleton

    token_url = _keycloak_token_url()
    client_id = os.environ.get("KEYCLOAK_CLIENT_ID")
    client_secret = os.environ.get("KEYCLOAK_CLIENT_SECRET")
    if not token_url or not client_id or not client_secret:
        log_event(
            logger,
            "warn",
            "get_google_credentials: Keycloak client_credentials not configured; "
            "returning None (Google access fail-closed).",
        )
        return None

    wif = _wif_params()
    if wif is None:
        log_event(
            logger,
            "warn",
            "get_google_credentials: WIF audience not configured; "
            "returning None (Google access fail-closed).",
        )
        return None

    try:
        supplier = _KeycloakSubjectTokenSupplier(token_url, client_id, client_secret)
        creds = identity_pool.Credentials(
            audience=wif["audience"],
            subject_token_type=wif["subject_token_type"],
            token_url=wif["token_url"],
            service_account_impersonation_url=wif["service_account_impersonation_url"],
            subject_token_supplier=supplier,
            scopes=[_CLOUD_PLATFORM_SCOPE],
        )
    except Exception as err:  # noqa: BLE001 — fail-closed: never raise from the factory
        log_event(
            logger,
            "warn",
            "get_google_credentials: WIF credential construction failed; returning None.",
            {"err": type(err).__name__},
        )
        return None

    _credentials_singleton = creds
    return creds
