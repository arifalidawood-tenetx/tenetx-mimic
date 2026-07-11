"""Listen-host resolution, ported from tenetx-mimic-backend/src/index.ts:551-555.

The Node backend resolves its uvicorn/express bind host as:

    export function resolveListenHost(): string {
      return process.env.HOST || '0.0.0.0';
    }

Ported 1:1 so the Python service binds identically to the Node backend it
replaces. `app.main` passes the result to `uvicorn.run(..., host=...)`.
"""
from __future__ import annotations

import os


def resolve_listen_host() -> str:
    """Return the bind host: ``$HOST`` when set to a non-empty value, else ``0.0.0.0``.

    Mirrors the JS ``process.env.HOST || '0.0.0.0'``. JS treats both ``undefined``
    and the empty string as falsy, so an unset OR empty ``HOST`` falls through to
    the default. Python's ``or`` has the same short-circuit semantics on the
    empty string, so ``os.environ.get("HOST") or "0.0.0.0"`` is an exact port.
    """
    return os.environ.get("HOST") or "0.0.0.0"
