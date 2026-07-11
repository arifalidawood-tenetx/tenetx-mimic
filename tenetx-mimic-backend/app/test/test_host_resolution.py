"""Ported from tenetx-mimic-backend/test/resolveListenHost.test.ts.

The vitest suite saves/restores ``process.env.HOST`` around each case
(beforeEach/afterEach); pytest's ``monkeypatch`` fixture provides the same
save-and-auto-restore isolation.

Cases ported 1:1:
- HOST unset            -> '0.0.0.0'
- HOST '127.0.0.1'      -> '127.0.0.1'
- HOST '192.168.1.100'  -> '192.168.1.100'

Plus one extra case locking the JS-falsy parity that the port hinges on
(``process.env.HOST || '0.0.0.0'`` treats '' as falsy).
"""
from __future__ import annotations

import pytest

from app.host_resolution import resolve_listen_host


def test_returns_default_when_host_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOST", raising=False)
    assert resolve_listen_host() == "0.0.0.0"


def test_returns_literal_when_host_is_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOST", "127.0.0.1")
    assert resolve_listen_host() == "127.0.0.1"


def test_returns_literal_when_host_is_arbitrary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOST", "192.168.1.100")
    assert resolve_listen_host() == "192.168.1.100"


def test_returns_default_when_host_is_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    # JS `process.env.HOST || '0.0.0.0'` treats '' as falsy -> default 0.0.0.0.
    monkeypatch.setenv("HOST", "")
    assert resolve_listen_host() == "0.0.0.0"
