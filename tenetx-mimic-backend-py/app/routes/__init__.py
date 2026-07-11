"""HTTP route modules for the tenetx-mimic Python backend.

Each module exposes an ``APIRouter`` (``router``) that ``app/main.py`` mounts via
``app.include_router(...)``. The first is ``verify_metadata`` (todo 4); the four
``/saml/*`` routes are added by later migration todos.
"""
from __future__ import annotations
