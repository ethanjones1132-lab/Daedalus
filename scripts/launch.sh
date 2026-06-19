#!/bin/bash
# Home Base v2.0 - Unified Launch
# Starts: Bun Jarvis API (port 19877) + TCP Bridge (port 19876)
# Then delegates the Tauri dev shell back to Windows
set -euo pipefail

PROJECT="/home/ethan/.openclaw/agents/coderclaw/workspace/home-base"
LOGS="/tmp/home-base-logs"
PORT=19877
NO_TAURI=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-tauri) NO_TAURI=true; shift ;;
        --port) PORT="$2"; shift 2 ;;
        *) shift ;;
    esac
done

mkdir -p "$LOGS"

echo "═══════════════════════════════════════════════════"
echo "  Home Base v2.0 - Launch"
echo "═══════════════════════════════════════════════════"

echo "[home-base] Cleaning up old processes..."
pkill -f "bun.*server-jarvis" 2>/dev/null || true
pkill -f "bun.*bridge.ts" 2>/dev/null || true
sleep 1

echo "[home-base] Starting Bun Jarvis API (port $PORT)..."
cd "$PROJECT"
export PATH="$HOME/.bun/bin:$PATH"

nohup bun run ./server-jarvis/src/index.ts > "$LOGS/bun.log" 2>&1 &
BUN_PID=$!
echo "[home-base] Bun PID: $BUN_PID"

echo "[home-base] Waiting for API..."
for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
        echo "[home-base] OK Bun API ready on port $PORT"
        break
    fi
    if ! kill -0 $BUN_PID 2>/dev/null; then
        echo "[home-base] FAIL Bun process died. Check $LOGS/bun.log"
        cat "$LOGS/bun.log"
        exit 1
    fi
    sleep 0.5
done

HEALTH=$(curl -sf "http://localhost:$PORT/status" 2>/dev/null || echo "{}")
BACKEND=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('backend','unknown'))" 2>/dev/null || echo "unknown")
MODEL=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','unknown'))" 2>/dev/null || echo "unknown")
OLLAMA_RUNNING=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ollama_running',False))" 2>/dev/null || echo "unknown")
MODEL_AVAILABLE=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ollama_model_available',False))" 2>/dev/null || echo "unknown")

echo "[home-base] Backend: $BACKEND | Model: $MODEL"
echo "[home-base] Ollama running: $OLLAMA_RUNNING | Model available: $MODEL_AVAILABLE"

if [ "$OLLAMA_RUNNING" = "False" ] || [ "$OLLAMA_RUNNING" = "unknown" ]; then
    echo "[home-base] WARN Ollama not detected. Make sure ollama serve is running on Windows."
    echo "[home-base]   Or switch to OpenRouter backend in the Config panel."
fi

if [ "$MODEL_AVAILABLE" = "False" ] || [ "$MODEL_AVAILABLE" = "unknown" ]; then
    echo "[home-base] WARN Model $MODEL not found. Run: ollama pull $MODEL"
fi

if [ "$NO_TAURI" = false ]; then
    echo "[home-base] Starting Windows Tauri dev shell..."
    nohup "$PROJECT/scripts/tauri-dev.sh" > "$LOGS/tauri.log" 2>&1 &
    TAURI_PID=$!
    echo "[home-base] Tauri PID: $TAURI_PID"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Home Base v2.0 is live!"
echo "  - Bun Jarvis API : http://localhost:$PORT"
echo "  - TCP Bridge     : localhost:19876"
echo "  - Backend        : $BACKEND ($MODEL)"
echo "  - Logs           : $LOGS/"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  To stop: pkill -f bun && pkill -f cargo"