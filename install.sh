#!/usr/bin/env bash
set -euo pipefail

# ── Beluga VPS Install Script ────────────────────────────────
# Run on a fresh Linux VPS (Ubuntu 22.04/24.04 recommended):
#   curl -fsSL <raw-url> | sudo bash
# Or:
#   sudo ./install.sh
#
# configurable via env vars:
#   BELUGA_REPO        - git repo URL (default: prompt)
#   BELUGA_BRANCH      - git branch (default: main)
#   BELUGA_DIR         - install dir (default: /opt/beluga)
#   BELUGA_DB_PASSWORD - postgres password (default: generated)
#   BELUGA_PORT        - HTTP port (default: 8080)
# ─────────────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${GREEN}[beluga]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[beluga]${RESET} $*"; }
error() { echo -e "${RED}[beluga]${RESET} $*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  error "run as root: sudo ./install.sh"
fi

if [[ ! -f /etc/os-release ]]; then
  error "cannot detect OS. supported: Ubuntu 22.04/24.04"
fi

# defaults
BELUGA_REPO="${BELUGA_REPO:-https://github.com/aspectrr/beluga}"
BELUGA_BRANCH="${BELUGA_BRANCH:-main}"
BELUGA_DIR="${BELUGA_DIR:-/opt/beluga}"
BELUGA_DB_PASSWORD="${BELUGA_DB_PASSWORD:-$(openssl rand -hex 16)}"
BELUGA_PORT="${BELUGA_PORT:-8080}"
CONFIG_DIR="/etc/beluga"

info "Beluga VPS installer"
echo ""

# ── Prompt for repo if not set ───────────────────────────────

if [[ -z "$BELUGA_REPO" ]]; then
  read -rp "Git repo URL (e.g. https://github.com/user/beluga): " BELUGA_REPO
  if [[ -z "$BELUGA_REPO" ]]; then
    error "repo URL required. set BELUGA_REPO or re-run."
  fi
fi

# ── Prompt for LLM config ────────────────────────────────────

read -rp "LLM API key: " LLM_API_KEY
read -rp "LLM endpoint [https://api.openai.com/v1]: " LLM_API_ENDPOINT
LLM_API_ENDPOINT="${LLM_API_ENDPOINT:-https://api.openai.com/v1}"
read -rp "LLM model [gpt-4o]: " LLM_MODEL
LLM_MODEL="${LLM_MODEL:-gpt-4o}"

echo ""
info "install dir:    ${BELUGA_DIR}"
info "config dir:     ${CONFIG_DIR}"
info "db password:    (generated)"
info "http port:      ${BELUGA_PORT}"
info "llm endpoint:   ${LLM_API_ENDPOINT}"
info "llm model:      ${LLM_MODEL}"
echo ""
read -rp "look good? [Y/n] " confirm
[[ "${confirm,,}" == "n" ]] && error "aborted."

# ── 1. System deps ───────────────────────────────────────────

info "installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git unzip ca-certificates gnupg >/dev/null

# ── 2. Bun ────────────────────────────────────────────────────

if ! command -v bun &>/dev/null; then
  info "installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # also make available system-wide
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
else
  info "bun already installed ($(bun --version))"
fi

# ── 3. Docker ─────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  info "installing docker..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable --now docker
else
  info "docker already installed ($(docker --version))"
fi

# ── 4. Clone repo ─────────────────────────────────────────────

if [[ -d "$BELUGA_DIR" ]]; then
  warn "${BELUGA_DIR} exists, pulling latest..."
  cd "$BELUGA_DIR"
  git fetch origin "$BELUGA_BRANCH"
  git reset --hard "origin/${BELUGA_BRANCH}"
else
  info "cloning ${BELUGA_REPO}..."
  git clone -b "$BELUGA_BRANCH" "$BELUGA_REPO" "$BELUGA_DIR"
  cd "$BELUGA_DIR"
fi

info "installing dependencies..."
bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# ── 5. Postgres (Docker) ─────────────────────────────────────

if ! docker ps --format '{{.Names}}' | grep -q '^beluga-postgres$'; then
  info "starting postgres..."
  docker run -d \
    --name beluga-postgres \
    --restart unless-stopped \
    -e POSTGRES_DB=beluga \
    -e POSTGRES_USER=beluga \
    -e POSTGRES_PASSWORD="$BELUGA_DB_PASSWORD" \
    -v beluga-pgdata:/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 \
    postgres:17 >/dev/null

  info "waiting for postgres to be ready..."
  for i in $(seq 1 30); do
    if docker exec beluga-postgres pg_isready -U beluga &>/dev/null; then
      break
    fi
    sleep 1
  done
else
  info "postgres already running"
fi

# ── 6. Config ────────────────────────────────────────────────

info "writing config..."

mkdir -p "${CONFIG_DIR}/prompts"
mkdir -p "${CONFIG_DIR}/extensions"
mkdir -p "${CONFIG_DIR}/agents/default"

# config.json
cat > "${CONFIG_DIR}/config.json" <<EOF
{
  "llm": {
    "endpoint": "${LLM_API_ENDPOINT}",
    "apiKey": "\${LLM_API_KEY}",
    "model": "\${LLM_MODEL}"
  },
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "name": "beluga",
    "user": "beluga",
    "password": "\${BELUGA_DB_PASSWORD}",
    "sslmode": "disable",
    "maxConnections": 20
  },
  "workspace": {
    "dockerHost": "",
    "agentImage": "beluga/agent-workspace:latest",
    "cpuLimit": "1.0",
    "memoryLimit": "1g",
    "idleTimeout": "1h",
    "networkMode": "none"
  },
  "agent": {
    "maxIterations": 30,
    "maxContextTokens": 128000
  },
  "extensions": {},
  "agents": {
    "default": { "enabled": true }
  },
  "routing": {
    "_default": "default"
  }
}
EOF

# default system prompt
if [[ ! -f "${CONFIG_DIR}/prompts/SYSTEM.md" ]]; then
  cat > "${CONFIG_DIR}/prompts/SYSTEM.md" <<'EOF'
# Beluga Agent

You are Beluga, an AI agent that helps users manage tasks and projects.
You have access to tools in a workspace sandbox and can interact with external services via extensions.
Always respond concisely and accurately.
EOF
fi

# default agent manifest
if [[ ! -f "${CONFIG_DIR}/agents/default/agent.json" ]]; then
  cat > "${CONFIG_DIR}/agents/default/agent.json" <<EOF
{
  "name": "default",
  "version": "0.1.0",
  "description": "Default Beluga agent",
  "systemPrompt": "../../prompts/SYSTEM.md",
  "extensions": []
}
EOF
fi

# ── 6.5. Build workspace image ──────────────────────────────────

info "building workspace image..."
cd "$BELUGA_DIR"
if [[ -f workspace.Dockerfile ]]; then
  docker build -f workspace.Dockerfile -t beluga/agent-workspace . 2>/dev/null || {
    warn "workspace image build failed — containers will use ubuntu:24.04 fallback"
  }
fi

# ── 7. Migrations ────────────────────────────────────────────

info "running database migrations..."
cd "$BELUGA_DIR"

run_migrations() {
  BELUGA_DB_HOST=127.0.0.1 \
  BELUGA_DB_PASSWORD="$BELUGA_DB_PASSWORD" \
    bun run db:migrate 2>&1
}

run_push() {
  BELUGA_DB_HOST=127.0.0.1 \
  BELUGA_DB_PASSWORD="$BELUGA_DB_PASSWORD" \
    bun x drizzle-kit push 2>&1
}

if ! run_migrations; then
  warn "drizzle migrate failed, trying db:push..."
  if ! run_push; then
    warn "db:push failed, resetting database and retrying..."
    docker exec beluga-postgres psql -U beluga -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>&1
    if ! run_migrations && ! run_push; then
      error "database migrations failed after reset. check logs above."
    fi
  fi
fi

# ── 8. Systemd service ───────────────────────────────────────

info "installing systemd service..."

cat > /etc/systemd/system/beluga.service <<EOF
[Unit]
Description=Beluga Agent Orchestrator
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${BELUGA_DIR}
ExecStart=/usr/local/bin/bun run src/main.ts start -c ${CONFIG_DIR}/config.json
Restart=always
RestartSec=5

Environment=LLM_API_KEY=${LLM_API_KEY}
Environment=LLM_API_ENDPOINT=${LLM_API_ENDPOINT}
Environment=LLM_MODEL=${LLM_MODEL}
Environment=BELUGA_DB_PASSWORD=${BELUGA_DB_PASSWORD}
Environment=BELUGA_PORT=${BELUGA_PORT}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable beluga
systemctl restart beluga

# ── 9. Done ──────────────────────────────────────────────────

sleep 2
if systemctl is-active --quiet beluga; then
  info "beluga is running on port ${BELUGA_PORT}"
else
  warn "beluga may not have started. check: journalctl -u beluga -f"
fi

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}  Beluga installed!${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo ""
echo "  config:    ${CONFIG_DIR}/config.json"
echo "  logs:      journalctl -u beluga -f"
echo "  restart:   systemctl restart beluga"
echo "  stop:      systemctl stop beluga"
echo "  health:    curl http://localhost:${BELUGA_PORT}/health"
echo ""
echo "  database:  docker exec -it beluga-postgres psql -U beluga"
echo "  db pass:   stored in systemd env (BELUGA_DB_PASSWORD)"
echo ""
echo -e "  ${YELLOW}next: put a reverse proxy (caddy/nginx) in front for HTTPS${RESET}"
echo ""
