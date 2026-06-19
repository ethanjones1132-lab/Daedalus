#!/bin/bash
set -euo pipefail

# [BROWSER]://<[TOPOLOGY]: [WIN32::[Tauri Shell] <-> [Bun Server]::[WSL2/UBUNTU]>//
# Standalone optimized build pipeline. No legacy build files are sourced.

# Ensure bun is on PATH (login shell entry from ~/.profile / ~/.bashrc)
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:$PATH"

C_RED='\033[38;5;196m'; C_GRN='\033[38;5;034m'
C_YLW='\033[38;5;214m'; C_CYN='\033[38;5;051m'
RST='\033[0m'

log_info() { echo -e "[${C_CYN}INFO${RST}] $1"; }
log_ok()   { echo -e "[${C_GRN} OK ${RST}] $1"; }
log_warn() { echo -e "[${C_YLW}WARN${RST}] $1"; }
log_err()  { echo -e "[${C_RED}FAIL${RST}] $1"; exit 1; }

ROOT="/home/ethan/.openclaw/agents/coderclaw/workspace/home-base"
UI="${ROOT}/src-ui"
SVR="${ROOT}/server-jarvis"
TAURI="${ROOT}/src-tauri"

log_info "Project Root: ${ROOT}"
log_info "Bun: $(command -v bun) ($($(command -v bun) --version 2>/dev/null || echo 'unknown'))"

# Step 0: Install UI deps with bun
cd "${UI}"
log_info "Installing UI dependencies..."
if [ -f bun.lockb ] || [ -f bun.lock ]; then
    bun install --frozen-lockfile
else
    bun install
fi
log_ok "UI dependencies installed"

# Step 1: Build frontend
cd "${UI}"
log_info "Building Vite frontend..."
bun run build
log_ok "Frontend built successfully"

# Step 2: Build Bun server
cd "${SVR}"
log_info "Building server-jarvis (bun bundle)..."
bun build ./src/index.ts --outdir ./dist --target bun
log_ok "Server bundle created in server-jarvis/dist/"

echo ""
log_ok "BUILD SUCCESS -- Frontend + Server ready for Tauri packaging"