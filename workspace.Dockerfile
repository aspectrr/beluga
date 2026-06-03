# ── Beluga Agent Workspace (base) ───────────────────────────
# Minimal base for workspace sandboxes. Ships with:
#   - Python 3.12 + pip
#   - Node.js 22 + npm
#   - Bun runtime
#   - beluga CLI
#
# Extensions layer on top via `beluga workspace build`.
# To customize the base image itself, edit this file and rebuild.
#
# ── Build ───────────────────────────────────────────────────
#   From repo root:
#     docker build -f workspace.Dockerfile -t beluga/agent-workspace .
#
#   Or let `beluga workspace build` handle it automatically.
# ────────────────────────────────────────────────────────────

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=development
WORKDIR /workspace

# ── System packages ─────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    openssh-client \
    build-essential \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Python 3.12 ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && ln -sf /usr/bin/pip3 /usr/bin/pip

# ── Node.js 22 (via NodeSource) ─────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Bun ─────────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# ── Beluga CLI ──────────────────────────────────────────────
# Install from the repo source. This runs during `docker build`
# from the beluga repo root, so the source is available via COPY.
COPY package.json bun.lock ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/sdk/src packages/sdk/src
COPY src src
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production \
    && printf '#!/bin/sh\nexec bun run /workspace/src/main.ts "$@"\n' > /usr/local/bin/beluga \
    && chmod +x /usr/local/bin/beluga

# ── Workspace directory ─────────────────────────────────────
RUN mkdir -p /workspace && chmod 777 /workspace

# ── Healthcheck ─────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD which python && which node && which bun || exit 1

# Keep container alive as a long-running target for docker exec.
# /bin/bash exits immediately without a TTY; sleep infinity runs forever.
CMD ["sleep", "infinity"]
