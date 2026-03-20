#!/bin/bash
set -e

# ─────────────────────────────────────────────
#  clipgsm setup script
#  Run from repo root: bash setup.sh
# ─────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}║       clipgsm — setup                ║${RESET}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; }
info() { echo -e "  ${CYAN}→${RESET}  $1"; }

bail() {
  echo ""
  fail "$1"
  echo ""
  exit 1
}

# ─── 1. Check system dependencies ────────────────────────────────────────────

echo -e "${BOLD}[1/4] Checking system dependencies...${RESET}"

# Find compatible Python (3.10–3.13); torch/numba don't support 3.14+ yet
PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" &>/dev/null; then
    MAJOR=$("$candidate" -c "import sys; print(sys.version_info.major)" 2>/dev/null)
    MINOR=$("$candidate" -c "import sys; print(sys.version_info.minor)" 2>/dev/null)
    if [ "$MAJOR" -eq 3 ] && [ "$MINOR" -ge 10 ] && [ "$MINOR" -le 13 ]; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  bail "No compatible Python found (need 3.10–3.13 — torch/numba don't support 3.14+ yet). Install Python 3.12 from https://python.org then re-run."
fi
ok "$($PYTHON_BIN --version) found (compatible)"

if ! command -v node &>/dev/null; then
  bail "Node.js is not installed. Install it from https://nodejs.org (LTS version) then re-run this script."
fi
ok "Node.js $(node -v) found"

if ! command -v ffmpeg &>/dev/null; then
  bail "ffmpeg is not installed. Run: brew install ffmpeg — then re-run this script."
fi
ok "ffmpeg found"

# ─── 2. Install Python dependencies ──────────────────────────────────────────

echo ""
echo -e "${BOLD}[2/4] Installing Python dependencies...${RESET}"

if [ ! -f "app/backend/venv/bin/activate" ]; then
  info "Setting up backend venv..."
  (cd app/backend && $PYTHON_BIN -m venv venv && source venv/bin/activate && pip install -r requirements.txt -q)
  ok "Backend dependencies installed"
else
  ok "Backend venv already exists — skipping"
fi

if [ ! -f "app/ai/venv/bin/activate" ]; then
  info "Setting up AI venv (torch + demucs — this takes a few minutes first time)..."
  (cd app/ai && $PYTHON_BIN -m venv venv && source venv/bin/activate && pip install -r requirements.txt -q)
  ok "AI dependencies installed"
else
  ok "AI venv already exists — skipping"
fi

# ─── 3. Install frontend dependencies ────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/4] Installing frontend dependencies...${RESET}"

if [ ! -d "app/clipgsm/node_modules" ]; then
  info "Running npm install..."
  (cd app/clipgsm && npm install --silent)
  ok "npm packages installed"
else
  ok "node_modules already exists — skipping"
fi

# ─── 4. Configure frontend URL ───────────────────────────────────────────────

echo ""
echo -e "${BOLD}[4/4] Configuring frontend...${RESET}"

ENV_FILE="app/clipgsm/.env"

detect_lan_ip() {
  if command -v ipconfig &>/dev/null; then
    IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    if [ -n "$IP" ]; then echo "$IP"; return; fi
  fi
  if command -v hostname &>/dev/null; then
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$IP" ]; then echo "$IP"; return; fi
  fi
  if command -v ip &>/dev/null; then
    IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
    if [ -n "$IP" ]; then echo "$IP"; return; fi
  fi
  echo ""
}

LAN_IP=$(detect_lan_ip)

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — leaving it unchanged"
  info "Current contents:"
  cat "$ENV_FILE" | sed 's/^/     /'
else
  if [ -n "$LAN_IP" ]; then
    echo "EXPO_PUBLIC_SERVER_URL=http://${LAN_IP}:8000" > "$ENV_FILE"
    ok "Created $ENV_FILE with your LAN IP (http://${LAN_IP}:8000)"
    info "This works for both simulator and physical phone on the same Wi-Fi"
  else
    echo "EXPO_PUBLIC_SERVER_URL=http://localhost:8000" > "$ENV_FILE"
    warn "Could not detect LAN IP — defaulting to localhost:8000"
    info "If using a physical phone, edit $ENV_FILE and replace localhost with your machine's IP"
  fi
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║               All done!              ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""
if [ -n "$LAN_IP" ]; then
echo -e "  Phone access at  → ${CYAN}http://${LAN_IP}:8000${RESET}"
fi
echo ""
echo -e "  Run ${CYAN}${BOLD}./run.sh${RESET} to start everything."
echo ""