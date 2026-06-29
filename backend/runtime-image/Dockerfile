# Cirrus runtime image — the single source of truth for the sandbox environment.
#
# Every runtime sandbox (E2B or Daytona) runs THIS image, with all six community-
# agent CLIs baked in so sandboxes start with them present (zero per-install wait).
#
# Why one public image instead of per-provider builds:
#   A custom E2B template / Daytona snapshot is private to the ORG that built it.
#   But users bring their OWN sandbox API keys, which authenticate a *different* org
#   that can't see our private template. A public OCI image is the portable unit
#   both providers can pull regardless of whose key is used:
#     • Daytona — `create({ image })` pulls this image directly at sandbox create.
#     • E2B     — `Template().fromImage(<this image>)` builds the template FROM it
#                 (see scripts/buildRuntimeTemplate.ts).
#
# Base on the E2B code-interpreter image so E2B's envd/Jupyter `runCode` keeps
# working; it also carries a system Node that Daytona's `codeRun` uses.
#
# Build & publish (publish to a PUBLIC registry so any user's key can pull it):
#   docker build -t ghcr.io/liu9293/cirrus-runtime:latest backend/runtime-image
#   docker push  ghcr.io/liu9293/cirrus-runtime:latest
# Then set RUNTIME_IMAGE to the pushed tag (config.ts default points here).
FROM e2bdev/code-interpreter:latest

USER root

# Reliable npm-published CLIs — one layer, fail the build if broken.
RUN npm install -g \
      opencode-ai \
      @anthropic-ai/claude-code \
      @openai/codex \
      @mariozechner/pi-coding-agent

# Pi has no built-in MCP; bake the MCP client extension so the pi driver can bridge
# platform tools (installs into the runtime user's ~/.pi). Best-effort.
RUN pi install npm:pi-mcp-extension || echo "[warn] pi-mcp-extension install failed"

# Hermes runs with --skip-setup so it stays in its own uv venv and skips the
# interactive gateway/browser stages. Best-effort: a failure only warns.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/h.sh \
      && bash /tmp/h.sh --skip-setup < /dev/null \
      || echo "[warn] hermes install failed"

# OpenClaw needs Node 24; its installer upgrades system Node via NodeSource, which
# breaks the code-interpreter base's Jupyter. Install Node 24 into an isolated prefix
# (/opt/node24, tarball — no apt, system Node stays for Jupyter), install OpenClaw
# there, and expose a PATH wrapper that runs it with Node 24. Best-effort.
RUN set -eux; \
    ARCH="$(uname -m)"; case "$ARCH" in aarch64) NA=arm64;; *) NA=x64;; esac; \
    curl -fsSL "https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-$NA.tar.xz" -o /tmp/n24.tar.xz \
      && mkdir -p /opt/node24 \
      && tar -xJf /tmp/n24.tar.xz -C /opt/node24 --strip-components=1 \
      && env PATH=/opt/node24/bin:$PATH /opt/node24/bin/npm install -g openclaw@latest \
      && printf '%s\n' '#!/bin/bash' 'exec env PATH=/opt/node24/bin:$PATH /opt/node24/bin/openclaw "$@"' > /usr/local/bin/openclaw \
      && chmod +x /usr/local/bin/openclaw \
      || echo "[warn] openclaw install failed"

# Record what we baked in, for debugging from inside the sandbox.
RUN for b in opencode claude codex pi hermes openclaw; do \
      printf "%s: %s\n" "$b" "$(command -v "$b" || echo MISSING)"; \
    done > /home/user/.cirrus-clis.txt || true
