#!/bin/bash

# ─────────────────────────────────────────────
#  clipgsm run script
#  Run from repo root: ./run.sh
# ─────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; }
info() { echo -e "  ${CYAN}→${RESET}  $1"; }

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════╗${RESET}"
echo -e "${CYAN}${BOLD}║       clipgsm — run                  ║${RESET}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════╝${RESET}"
echo ""

# ─── Check setup has been run ────────────────────────────────────────────────

if [ ! -f "app/backend/venv/bin/activate" ]; then
  fail "Backend venv not found. Run ./setup.sh first."
  exit 1
fi
if [ ! -f "app/ai/venv/bin/activate" ]; then
  fail "AI venv not found. Run ./setup.sh first."
  exit 1
fi
if [ ! -d "app/clipgsm/node_modules" ]; then
  fail "node_modules not found. Run ./setup.sh first."
  exit 1
fi

# ─── Kill anything already on port 8000 ──────────────────────────────────────

lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 1

# ─── Start backend ────────────────────────────────────────────────────────────

info "Starting backend..."
(cd app/backend && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000 --reload) &
BACKEND_PID=$!
ok "Backend started (PID $BACKEND_PID) → http://localhost:8000"

# Give backend a moment to boot
sleep 2

# ─── Cleanup on exit ─────────────────────────────────────────────────────────

cleanup() {
  echo ""
  info "Shutting down..."
  kill $BACKEND_PID 2>/dev/null
  echo -e "  ${GREEN}✓${RESET}  All stopped."
  exit 0
}
trap cleanup INT TERM

# ─── Start Expo ───────────────────────────────────────────────────────────────

info "Starting Expo..."
echo ""
echo -e "  ${YELLOW}${BOLD}Press Ctrl+C to stop everything.${RESET}"
echo ""

(cd app/clipgsm && npx expo start)

# If Expo exits normally, kill backend too
kill $BACKEND_PID 2>/dev/null