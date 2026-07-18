"""Pytest fixtures for app/test suite.

Harness for MIMIC_STATUS_SECRET: since status_token.SECRET is assigned at import
time from the environment, and tests run without MIMIC_STATUS_SECRET set, the
module falls back to DEV_ONLY_SECRET and emits a warning. This fixture pins a
known secret for deterministic token signing/verification in tests.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _harness_status_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin MIMIC_STATUS_SECRET for test suite.

    The status_token module reads MIMIC_STATUS_SECRET at import time and assigns
    it to the module-level SECRET variable. Since tests run without the env var
    set, the module falls back to DEV_ONLY_SECRET and logs a warning. This
    fixture monkeypatches the already-imported SECRET to a known test value,
    allowing deterministic token signing/verification without editing the
    product status_token.py logic.

    Autouse ensures every test gets a pinned secret.
    """
    import app.status_token

    monkeypatch.setattr(app.status_token, "SECRET", "test-secret-for-deterministic-tokens")
