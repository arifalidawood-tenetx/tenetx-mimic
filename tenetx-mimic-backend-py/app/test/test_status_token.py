"""Ported from tenetx-mimic-backend/test/statusToken.test.ts.

Every assertion in the vitest suite is reproduced 1:1 below (same cases, same
expected values). The Node suite pins ``MIMIC_STATUS_SECRET`` BEFORE importing
statusToken.ts (which reads the secret once at module-load); the Python port
reads its secret once at import too, so the ``_pin_secret`` autouse fixture
monkeypatches ``status_token.SECRET`` to the SAME known value instead — the
functions look ``SECRET``/``_now_ms`` up in module globals at call time, so the
patch takes effect without a reimport (see status_token.py's testability note).

On top of the 1:1 port, a cross-language interop section proves BYTE-compatibility
against the REAL Node ``statusToken.ts`` (via ``_interop_node.mts`` under ``tsx``):
  * a token signed by Python with a pinned clock+secret is byte-identical to one
    the real ``signStatus`` produces from the same inputs;
  * a token minted by the real Node ``signStatus`` verifies in Python;
  * a token signed in Python verifies in the real Node ``verifyStatus``.

Windows env note (see learnings.md, todo 6): the console is cp1252, so tests
NEVER print non-ASCII (only assert on it) and the Node subprocess is captured as
UTF-8.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest

import app.status_token as status_token
from app.status_token import sign_status, verify_status

# statusToken.test.ts:9 — any stable value works; sign+verify share it.
TEST_SECRET = "test-secret-for-statusToken-suite"


@pytest.fixture(autouse=True)
def _pin_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the module secret to a known value for every test, the Python analogue
    of statusToken.test.ts setting ``process.env.MIMIC_STATUS_SECRET`` before the
    dynamic import."""
    monkeypatch.setattr(status_token, "SECRET", TEST_SECRET)


def _forge(raw_payload: str, secret: str = TEST_SECRET) -> str:
    """Port of statusToken.test.ts:15-19. Build a token with a CORRECT signature
    over an arbitrary raw payload string, to drive verify_status past the
    signature check into its later (parse / object / iat) guards."""
    b64 = base64.urlsafe_b64encode(raw_payload.encode("utf-8")).rstrip(b"=").decode("ascii")
    signature = hmac.new(secret.encode("utf-8"), b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{b64}.{signature}"


# ---------------------------------------------------------------------------
# signStatus / verifyStatus round-trip (statusToken.test.ts:21-49)
# ---------------------------------------------------------------------------
def test_round_trips_a_signed_payload_back_to_the_original_object_plus_iat() -> None:
    token = sign_status({"status": "validated", "email": "a@b.com"})
    result = verify_status(token)
    assert result is not None
    assert result["status"] == "validated"
    assert result["email"] == "a@b.com"
    assert isinstance(result["iat"], int)


def test_embeds_an_iat_automatically_even_when_the_caller_omits_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stamped = 1_650_000_000_000
    monkeypatch.setattr(status_token, "_now_ms", lambda: stamped)
    token = sign_status({"status": "logged_out"})
    result = verify_status(token)
    assert result is not None
    assert result["iat"] == stamped


def test_produces_the_documented_base64url_dot_hex_token_shape() -> None:
    import re

    token = sign_status({"status": "validated"})
    parts = token.split(".")
    assert len(parts) == 2
    assert re.fullmatch(r"[A-Za-z0-9_-]+", parts[0])  # base64url alphabet
    assert re.fullmatch(r"[0-9a-f]{64}", parts[1])  # sha256 hex digest


# ---------------------------------------------------------------------------
# verifyStatus rejects invalid tokens (statusToken.test.ts:51-92)
# ---------------------------------------------------------------------------
def test_returns_none_for_a_tampered_signature_one_flipped_char() -> None:
    token = sign_status({"status": "validated", "email": "a@b.com"})
    b64, signature = token.split(".")
    flipped = ("1" if signature[0] == "0" else "0") + signature[1:]
    assert verify_status(f"{b64}.{flipped}") is None


def test_returns_none_when_the_payload_is_tampered() -> None:
    token = sign_status({"status": "validated"})
    b64, signature = token.split(".")
    assert verify_status(f"{b64}X.{signature}") is None


def test_returns_none_when_the_dot_separator_is_missing() -> None:
    assert verify_status("no-separator-here") is None


def test_returns_none_for_malformed_base64_garbage_input() -> None:
    assert verify_status("$$$.%%%") is None
    assert verify_status("....") is None


def test_returns_none_for_a_validly_signed_token_whose_payload_is_not_json() -> None:
    assert verify_status(_forge("this is definitely not json")) is None


def test_returns_none_for_a_validly_signed_non_object_payload() -> None:
    assert verify_status(_forge(json.dumps("just a string"))) is None
    assert verify_status(_forge(json.dumps([1, 2, 3]))) is None


def test_returns_none_for_a_validly_signed_payload_missing_a_numeric_iat() -> None:
    assert verify_status(_forge(json.dumps({"status": "validated"}))) is None


def test_returns_none_for_empty_or_non_string_input() -> None:
    assert verify_status("") is None
    assert verify_status(None) is None  # JS null + undefined -> Python None


# ---------------------------------------------------------------------------
# verifyStatus expiry — 5-minute window (statusToken.test.ts:94-117)
# ---------------------------------------------------------------------------
def test_accepts_a_token_just_within_the_5_minute_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = 1_577_836_800_000  # 2020-01-01T00:00:00.000Z
    monkeypatch.setattr(status_token, "_now_ms", lambda: base)
    token = sign_status({"status": "validated"})
    monkeypatch.setattr(status_token, "_now_ms", lambda: base + 299_000)  # +299000ms
    assert verify_status(token) is not None


def test_returns_none_for_a_token_older_than_5_minutes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base = 1_577_836_800_000  # 2020-01-01T00:00:00.000Z
    monkeypatch.setattr(status_token, "_now_ms", lambda: base)
    token = sign_status({"status": "validated", "email": "a@b.com"})
    monkeypatch.setattr(status_token, "_now_ms", lambda: base + 300_001)  # +300001ms
    assert verify_status(token) is None


# ---------------------------------------------------------------------------
# Additional guardrail coverage (never throws; frontend-decoder compatibility)
# ---------------------------------------------------------------------------
def test_tampered_token_returns_none_and_never_raises() -> None:
    # Task QA failure scenario: a flipped byte must return None, never throw.
    token = sign_status({"status": "validated", "email": "a@b.com"})
    b64, signature = token.split(".")
    flipped_payload = b64[:-1] + ("A" if b64[-1] != "A" else "B")
    for bad in (f"{flipped_payload}.{signature}", token[:-1] + ("0" if token[-1] != "0" else "1")):
        assert verify_status(bad) is None


def test_payload_half_matches_the_frontend_decode_shape() -> None:
    # TryItOutPage.tsx:81-99 decodeStatusToken: split('.')[0] -> base64url -> JSON.
    # Prove the payload half decodes to the exact dict we signed (+ iat).
    token = sign_status({"status": "validated", "email": "a@b.com", "reason": None})
    payload_part = token.split(".")[0]
    padded = payload_part + "=" * (-len(payload_part) % 4)
    decoded = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    assert decoded["status"] == "validated"
    assert decoded["email"] == "a@b.com"
    assert decoded["reason"] is None
    assert isinstance(decoded["iat"], int)


# ---------------------------------------------------------------------------
# Cross-language interop against the REAL Node statusToken.ts
# ---------------------------------------------------------------------------
_HERE = Path(__file__).resolve().parent
_HARNESS = _HERE / "_interop_node.mts"
_NODE_BACKEND = _HERE.parents[2] / "tenetx-mimic-backend"


def _node_available() -> bool:
    return (
        shutil.which("node") is not None
        and (_NODE_BACKEND / "node_modules" / "tsx").exists()
        and _HARNESS.exists()
    )


def _run_node(mode: str, extra_env: Optional[dict[str, str]] = None) -> dict[str, Any]:
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        ["node", "--import", "tsx", str(_HARNESS), mode],
        cwd=str(_NODE_BACKEND),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert proc.returncode == 0, f"node harness failed ({proc.returncode}): {proc.stderr}"
    start = proc.stdout.index("<<INTEROP_JSON>>") + len("<<INTEROP_JSON>>")
    end = proc.stdout.index("<<END_INTEROP_JSON>>")
    return json.loads(proc.stdout[start:end])


requires_node = pytest.mark.skipif(
    not _node_available(), reason="node/tsx not available for cross-language interop"
)


@requires_node
def test_interop_python_sign_is_byte_identical_to_real_node_sign(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The strongest proof: given the SAME secret + clock + payload, the Python
    signer emits the byte-for-byte identical ``<base64url>.<hex>`` token that the
    real Node ``signStatus`` does. Covers a non-ASCII payload value AND a
    non-ASCII UTF-8 secret key."""
    vectors = _run_node("vectors")
    monkeypatch.setattr(status_token, "SECRET", vectors["fixedSecret"])
    monkeypatch.setattr(status_token, "_now_ms", lambda: vectors["fixedIat"])
    assert sign_status(vectors["signPayload"]) == vectors["signToken"]


@requires_node
def test_interop_real_node_token_verifies_in_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Node -> Python: a token minted by the real ``signStatus`` decodes+verifies
    with the Python ``verify_status`` under the same secret."""
    vectors = _run_node("vectors")
    monkeypatch.setattr(status_token, "SECRET", vectors["fixedSecret"])
    # Keep the pinned-2023 iat inside the 5-minute window.
    monkeypatch.setattr(status_token, "_now_ms", lambda: vectors["fixedIat"] + 1000)
    result = verify_status(vectors["signToken"])
    assert result is not None
    assert result["status"] == "validated"
    assert result["email"] == "a@b.com"
    assert result["reason"] is None
    assert result["note"] == vectors["signPayload"]["note"]  # non-ASCII survived
    assert result["iat"] == vectors["fixedIat"]


@requires_node
def test_interop_python_token_verifies_in_real_node(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Python -> Node: a token signed by the Python ``sign_status`` verifies in
    the real Node ``verifyStatus`` (proving the HMAC + payload bytes are what Node
    expects). ASCII secret here to avoid any Windows env-var encoding ambiguity —
    the non-ASCII UTF-8 key path is already proven byte-identical above."""
    secret = "py-to-node-secret"
    stamped = 1_700_000_123_456
    monkeypatch.setattr(status_token, "SECRET", secret)
    monkeypatch.setattr(status_token, "_now_ms", lambda: stamped)
    token = sign_status({"status": "validated", "email": "qa@tenetx.ai", "note": "h\u00e9llo-\u4e2d"})

    payload = _run_node(
        "verify",
        {
            "INTEROP_SECRET": secret,
            "INTEROP_TOKEN": token,
            "INTEROP_NOW_MS": str(stamped + 1000),  # keep inside Node's 5-min window
        },
    )["result"]
    assert payload is not None
    assert payload["status"] == "validated"
    assert payload["email"] == "qa@tenetx.ai"
    assert payload["note"] == "h\u00e9llo-\u4e2d"
    assert payload["iat"] == stamped
