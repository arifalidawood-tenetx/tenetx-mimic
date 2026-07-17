# tenetx-mimic Python backend — PRODUCTION multi-stage image (migration todo 11).
#
# Stage 1 (builder): full C toolchain + -dev headers to COMPILE lxml + xmlsec from
# source into an isolated venv. Stage 2 (runtime): a fresh slim base that carries
# ONLY the runtime shared libraries (no compiler, no -dev headers), curl for
# Coolify's healthcheck, and the copied venv — run by a non-root user that owns the
# writable .captured/ SAMLResponse capture directory.
#
# Base is python:3.12-slim per the migration plan (todo 1).

# ---------------------------------------------------------------------------
# Stage 1 — builder: compile the native deps (lxml + xmlsec) against system libs.
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS builder

# Build toolchain + dev headers. lxml and xmlsec are BOTH compiled from source
# (forced below via --no-binary) so their C extensions link the SAME system
# libxml2 — a wheel-lxml paired with a source-xmlsec loads two different libxml2
# copies and segfaults at import. These -dev packages + the compiler are therefore
# genuinely load-bearing: remove one and the pip build fails (proven in the
# task-11 failure-path QA).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libxml2-dev \
        libxmlsec1-dev \
        libxmlsec1-openssl \
        libxslt1-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Isolated venv: stage 2 copies this ONE directory and runs it as a non-root user
# (a venv on PATH is user-agnostic, unlike pip --user's $HOME-scoped site-packages).
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# requirements first so the pip layer is cached across app-code edits (parity with
# the todo-1 stub's COPY-requirements-first shape).
COPY requirements.txt ./

# --no-binary lxml,xmlsec forces a source compile against the -dev headers above
# (a manylinux wheel would bundle its own libs and make the toolchain pointless).
RUN pip install --no-cache-dir --no-binary lxml,xmlsec -r requirements.txt

# ---------------------------------------------------------------------------
# Stage 2 — runtime: slim image, runtime .so libs only, non-root, uvicorn.
# ---------------------------------------------------------------------------
FROM python:3.12-slim

# curl: Coolify's container-internal healthcheck probes GET /health — same pattern
# as the Node Dockerfile (tenetx-mimic-backend/Dockerfile:3-5).
# libxml2 / libxmlsec1-openssl / libxslt1.1: the RUNTIME shared libraries the
# builder-compiled lxml + xmlsec extensions dynamically link against. NO -dev
# headers or compiler in this stage (smaller image, smaller attack surface).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        libxml2 \
        libxmlsec1-openssl \
        libxslt1.1 \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Dedicated non-root user, created BEFORE the chown below so the capture directory
# (and the venv) can be handed to it.
RUN groupadd --system appuser \
    && useradd --system --gid appuser --home-dir /home/appuser --create-home appuser

WORKDIR /app

# The dependency set compiled in stage 1.
COPY --from=builder /opt/venv /opt/venv

# App code — includes the vendored SAMLProvider (app/vendored/saml_provider.py +
# public_url.py), which rides along with app/ (no separate COPY needed).
COPY app ./app

# .captured/ is where POST /saml/acs persists every raw base64 SAMLResponse
# (app/routes/saml_acs.py's default MIMIC_CAPTURED_DIR = <_PACKAGE_ROOT>/.captured,
# and _PACKAGE_ROOT resolves to /app given WORKDIR /app + COPY app ./app — so the
# path is /app/.captured). Create it and chown /app + the venv to appuser BEFORE
# switching users; a non-root process cannot chown to itself, and if the capture
# dir is not writable the /saml/acs route's only 500 path (disk-write failure)
# would fire in production. Order is load-bearing.
RUN mkdir -p /app/.captured \
    && chown -R appuser:appuser /app /opt/venv

USER appuser

EXPOSE 3000

# Plan-pinned CMD (todo 11). NOTE: this hardcodes --host 0.0.0.0, bypassing todo 1's
# resolve_listen_host() HOST-env-var support (the stub CMD was
# ["python","-m","app.main"]). Per the plan this exact form is the acceptance
# criterion Coolify is configured against (todo 13); the HOST override is unused in
# the container as a result. Discrepancy recorded in the todo-11 evidence/notepad.
#
# Proxy headers (todo mcp-proxy-headers-trailing-slash wave 1): Coolify/Traefik is the
# sole ingress; port 3000 is not host-published; forwarded_allow_ips=* trusts
# X-Forwarded-* only from docker network peers — acceptable for this topology.
# Primary MCP bare-path fix is path rewrite (McpPathNormalizeMiddleware); proxy-headers
# is defense in depth for any leftover redirects.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000", "--proxy-headers", "--forwarded-allow-ips", "*"]
