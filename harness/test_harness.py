"""Unit tests for the TEN-141 SAML root-cause harness.

Run with the product venv interpreter (it ships python3-saml + pytest):

    tenetx-source-code-dontpush/.venv/Scripts/python.exe -m pytest \
        tenetx-mimic/harness/test_harness.py

The tests invoke the harness as a subprocess using ``sys.executable`` (the same
interpreter running pytest), so no re-exec is needed and the real SAMLProvider
is exercised end to end. They cover:
  - the known-bad synthetic unsigned fixture (a non-empty "Reason:" is printed,
    the process does not crash, exit 0);
  - a syntactically-malformed fixture (clean non-zero exit, no raw traceback);
  - a missing fixture and a non-Response XML root (clean non-zero exit).
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HARNESS_DIR, "keycloak_saml_harness.py")
SYNTHETIC_UNSIGNED = os.path.join(HARNESS_DIR, "fixtures", "synthetic-unsigned.xml")

_TRACEBACK_MARKER = "Traceback (most recent call last)"


def _run_harness(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, HARNESS, *args],
        capture_output=True,
        text=True,
    )


def test_synthetic_unsigned_files_exist() -> None:
    assert os.path.isfile(HARNESS), f"harness missing: {HARNESS}"
    assert os.path.isfile(SYNTHETIC_UNSIGNED), f"fixture missing: {SYNTHETIC_UNSIGNED}"


def test_known_bad_unsigned_prints_reason_and_exits_zero() -> None:
    result = _run_harness("--fixture", SYNTHETIC_UNSIGNED)
    combined = result.stdout + result.stderr

    assert result.returncode == 0, (
        f"expected exit 0 (harness catches the validation error itself), got "
        f"{result.returncode}\n--- output ---\n{combined}"
    )
    assert "Reason:" in combined, f"expected a 'Reason:' line, got:\n{combined}"

    reason = combined.split("Reason:", 1)[1].strip()
    assert reason, "the reason string after 'Reason:' must be non-empty"

    assert _TRACEBACK_MARKER not in combined, (
        f"a raw Python traceback leaked to the user:\n{combined}"
    )


def test_malformed_xml_clean_nonzero_exit(tmp_path) -> None:
    bad_fixture = tmp_path / "synthetic-malformed.xml"
    # Starts with '<' (so the harness treats it as XML) but is not well-formed.
    bad_fixture.write_text(
        '<samlp:Response Destination="https://app.tenetx.ai/api/saml/acs">'
        "<this-tag-is-never-closed",
        encoding="utf-8",
    )

    result = _run_harness("--fixture", str(bad_fixture))
    combined = result.stdout + result.stderr

    assert result.returncode != 0, (
        f"expected a non-zero exit on malformed XML, got 0\n{combined}"
    )
    assert _TRACEBACK_MARKER not in combined, (
        f"malformed XML must not leak a raw traceback:\n{combined}"
    )
    assert ("parse" in combined.lower()) or ("xml" in combined.lower()), (
        f"expected a clear parse-error message, got:\n{combined}"
    )


def test_missing_fixture_clean_nonzero_exit(tmp_path) -> None:
    missing = tmp_path / "does-not-exist.xml"
    result = _run_harness("--fixture", str(missing))
    combined = result.stdout + result.stderr

    assert result.returncode != 0, f"expected non-zero exit, got 0\n{combined}"
    assert _TRACEBACK_MARKER not in combined, combined
    assert "not found" in combined.lower(), (
        f"expected a clear 'not found' message, got:\n{combined}"
    )


def test_non_response_root_clean_nonzero_exit(tmp_path) -> None:
    not_a_response = tmp_path / "not-a-response.xml"
    not_a_response.write_text("<html><body>nope</body></html>", encoding="utf-8")

    result = _run_harness("--fixture", str(not_a_response))
    combined = result.stdout + result.stderr

    assert result.returncode != 0, combined
    assert _TRACEBACK_MARKER not in combined, combined
    assert "response" in combined.lower(), (
        f"expected a message noting it is not a SAML Response, got:\n{combined}"
    )
