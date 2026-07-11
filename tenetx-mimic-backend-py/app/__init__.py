"""tenetx-mimic Python backend.

Python replacement for tenetx-mimic-backend/ (Node/Express). The deployed Node
container has no python3 at all (`spawn python3 ENOENT` in prod), which broke the
SAML harness; this service runs the real product's SAMLProvider natively instead.

This module is the skeleton only: FastAPI app + /health + host binding. SAML and
XML routes are added by later migration todos.
"""
