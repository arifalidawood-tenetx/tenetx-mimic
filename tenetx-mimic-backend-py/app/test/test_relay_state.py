"""Ported from tenetx-mimic-backend/test/relayState.test.ts.

Every assertion in the vitest suite is reproduced 1:1 below (same cases, same
expected values). On top of the 1:1 port, a cross-language interop section
invokes the REAL Node ``relayState.ts`` (via ``_interop_node.mts`` under ``tsx``)
and asserts the Python port is BYTE-identical in both directions — an
encode/decode produced by Node decodes/encodes to the exact same value in Python
and vice versa, not merely "internally consistent".

Windows env note (see learnings.md, todo 6): the console is cp1252, so tests
NEVER print non-ASCII — they only assert on it — and the Node subprocess is
captured with ``encoding="utf-8"``.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest

from app.relay_state import decode_relay_state, encode_relay_state

# Same fixtures as relayState.test.ts:4-5.
RETURN_URL = "https://x/y"
LEGACY_URL = "https://tenetx-mimic.web.app/mimic/TEN-1/try-it-out"


# ---------------------------------------------------------------------------
# encodeRelayState (relayState.test.ts:7-23)
# ---------------------------------------------------------------------------
def test_returns_bare_return_url_verbatim_when_connection_doc_id_absent() -> None:
    assert encode_relay_state({"returnUrl": RETURN_URL}) == RETURN_URL


def test_returns_bare_return_url_verbatim_when_connection_doc_id_empty() -> None:
    assert encode_relay_state({"returnUrl": RETURN_URL, "connectionDocId": ""}) == RETURN_URL


def test_emits_mimicrs_prefixed_composite_when_connection_doc_id_present() -> None:
    encoded = encode_relay_state({"returnUrl": RETURN_URL, "connectionDocId": "abc123"})
    assert encoded.startswith("mimicrs:")
    assert encoded != RETURN_URL


# ---------------------------------------------------------------------------
# decodeRelayState (relayState.test.ts:25-70)
# ---------------------------------------------------------------------------
def test_round_trips_a_composite_with_connection_doc_id() -> None:
    encoded = encode_relay_state({"returnUrl": RETURN_URL, "connectionDocId": "abc123"})
    assert decode_relay_state(encoded) == {
        "returnUrl": RETURN_URL,
        "connectionDocId": "abc123",
    }


def test_round_trips_a_composite_without_connection_doc_id() -> None:
    encoded = encode_relay_state({"returnUrl": RETURN_URL})
    decoded = decode_relay_state(encoded)
    assert decoded == {"returnUrl": RETURN_URL}
    # JS asserts `decoded?.connectionDocId` is undefined -> key absent in Python.
    assert decoded is not None and "connectionDocId" not in decoded


def test_passes_a_bare_legacy_relay_state_url_through_unchanged() -> None:
    decoded = decode_relay_state(LEGACY_URL)
    assert decoded == {"returnUrl": LEGACY_URL}
    assert decoded is not None and "connectionDocId" not in decoded


def test_falls_through_malformed_mimicrs_garbage_to_bare_url() -> None:
    raw = "mimicrs:garbage-not-base64!!!"
    # Must never throw and never return None — degrades to a bare returnUrl.
    decoded: Optional[dict[str, str]] = None

    def _call() -> None:
        nonlocal decoded
        decoded = decode_relay_state(raw)

    # Assert-not-raises: any exception here fails the test outright.
    _call()
    assert decoded == {"returnUrl": raw}


def test_falls_through_a_mimicrs_composite_whose_json_lacks_a_return_url() -> None:
    # Valid base64url + valid JSON, but no usable returnUrl -> bare-URL fallback.
    # Build it exactly as relayState.test.ts:58 does (base64url of the JSON).
    import base64

    payload = json.dumps({"connectionDocId": "abc123"}, separators=(",", ":"))
    b64 = base64.urlsafe_b64encode(payload.encode("utf-8")).rstrip(b"=").decode("ascii")
    encoded = f"mimicrs:{b64}"
    assert decode_relay_state(encoded) == {"returnUrl": encoded}


def test_returns_none_for_empty_string_input() -> None:
    assert decode_relay_state("") is None


def test_returns_none_for_non_string_input() -> None:
    # JS tested null / undefined / 123 — Python's None covers null+undefined.
    assert decode_relay_state(None) is None
    assert decode_relay_state(123) is None


# ---------------------------------------------------------------------------
# Cross-language interop against the REAL Node relayState.ts
# ---------------------------------------------------------------------------
_HERE = Path(__file__).resolve().parent
_HARNESS = _HERE / "_interop_node.mts"
# _HERE = .../tenetx-mimic-backend-py/app/test ; parents[2] = .../tenetx-mimic
_NODE_BACKEND = _HERE.parents[2] / "tenetx-mimic-backend"


def _node_available() -> bool:
    return (
        shutil.which("node") is not None
        and (_NODE_BACKEND / "node_modules" / "tsx").exists()
        and _HARNESS.exists()
    )


def _run_node(mode: str, extra_env: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """Invoke the REAL Node relayState.ts/statusToken.ts via the tsx harness and
    return the JSON it emits between the interop markers. Captured as UTF-8 so
    non-ASCII round-trips survive the Windows cp1252 default."""
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
def test_interop_python_encode_matches_real_node_encode_byte_for_byte() -> None:
    vectors = _run_node("vectors")
    for case in vectors["relayEncode"]:
        assert encode_relay_state(case["input"]) == case["output"]


@requires_node
def test_interop_python_decode_matches_real_node_decode() -> None:
    vectors = _run_node("vectors")
    for case in vectors["relayDecode"]:
        assert decode_relay_state(case["input"]) == case["output"]


@requires_node
def test_interop_python_encoded_composite_decodes_in_real_node() -> None:
    # Python -> Node direction: encode a composite in Python, hand the exact
    # string to the real Node decodeRelayState, assert it recovers both fields.
    encoded = encode_relay_state({"returnUrl": LEGACY_URL, "connectionDocId": "py-doc-42"})
    result = _run_node("relaydecode", {"INTEROP_RELAY": encoded})["result"]
    assert result == {"returnUrl": LEGACY_URL, "connectionDocId": "py-doc-42"}
