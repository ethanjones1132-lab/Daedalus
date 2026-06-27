#!/usr/bin/env bash
# verify.sh — fast "is everything still OK" check across all subsystems
# (server-jarvis / src-ui / src-tauri) plus the claude_cli proxy.
#
# Built for troubleshooting: it runs EVERY check (does NOT stop at the first
# failure) and only prints a step's output when that step fails — so a green run
# is a handful of lines and a red run shows exactly what broke and nothing else.
#
# Usage:
#   ./scripts/verify.sh                    fast: proxy, server build+test, ui typecheck, rust check
#   ./scripts/verify.sh --only rust        one subsystem: proxy | server | ui | rust
#   ./scripts/verify.sh --test             also compile+run the Rust tests
#   ./scripts/verify.sh --clippy           also run cargo clippy -D warnings
#   ./scripts/verify.sh --build            also produce artifacts (server dist + ui vite build)
#   ./scripts/verify.sh --build-tauri      also build the debug Tauri binary (no installer)
#   ./scripts/verify.sh -h
#
# From Windows PowerShell / cmd:
#   wsl bash ~/.openclaw/agents/coderclaw/workspace/home-base/scripts/verify.sh
#
# Exit code is 0 only if every run step passed.

set -uo pipefail   # deliberately NOT -e: we run all steps then summarize.

# Make bun/cargo/python visible even from a bare (non-login) shell.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

C_RED=$'\033[38;5;196m'; C_GRN=$'\033[38;5;034m'
C_YLW=$'\033[38;5;214m'; RST=$'\033[0m'
# No color when output isn't a terminal (e.g. captured/piped), so logs stay clean.
if [ ! -t 1 ]; then C_RED=''; C_GRN=''; C_YLW=''; RST=''; fi

ONLY=""; DO_TEST=0; DO_CLIPPY=0; DO_BUILD=0; DO_BUILD_TAURI=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only)         ONLY="${2:-}"; shift 2 ;;
    --test|-t)      DO_TEST=1; shift ;;
    --clippy)       DO_CLIPPY=1; shift ;;
    --build|-b)     DO_BUILD=1; shift ;;
    --build-tauri)  DO_BUILD_TAURI=1; shift ;;
    -h|--help)      sed -n '2,30{/^#/!q;s/^# \{0,1\}//;p}' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (try -h)"; exit 2 ;;
  esac
done

PASS=0; FAIL=0; FAILED=()
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
have() { command -v "$1" >/dev/null 2>&1; }
skip() { printf '[%sSKIP%s] %s\n' "$C_YLW" "$RST" "$1"; }

# run <label> <workdir> <command...> — captures output, prints it only on failure.
run() {
  local label="$1" dir="$2"; shift 2
  local start out rc dur
  start=$(date +%s)
  out="$(cd "$dir" 2>/dev/null && "$@" 2>&1)"; rc=$?
  dur=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then
    printf '[%s OK %s] %-22s %ss\n' "$C_GRN" "$RST" "$label" "$dur"
    PASS=$((PASS+1))
  else
    printf '[%sFAIL%s] %-22s %ss\n' "$C_RED" "$RST" "$label" "$dur"
    printf '%s\n' "$out" | sed 's/^/    /'
    FAIL=$((FAIL+1)); FAILED+=("$label")
  fi
}

echo "── verify @ $ROOT ──"

if want proxy; then
  if have python3; then
    run "proxy py_compile" "$ROOT" python3 -m py_compile scripts/claude_cli_proxy.py
  else skip "proxy (python3 not found)"; fi
fi

if want server; then
  if have bun; then
    tmp="$(mktemp -d)"
    run "server build" "$ROOT/server-jarvis" bun build ./src/index.ts --outdir "$tmp" --target bun
    rm -rf "$tmp"
    run "server test" "$ROOT/server-jarvis" bun test
  else skip "server (bun not found)"; fi
fi

if want ui; then
  if have bun; then
    run "ui tsc -b" "$ROOT/src-ui" bunx tsc -b
  else skip "ui (bun not found)"; fi
fi

if want rust; then
  if have cargo; then
    run "rust cargo check" "$ROOT" cargo check --manifest-path "$ROOT/src-tauri/Cargo.toml"
    [ $DO_CLIPPY -eq 1 ] && run "rust clippy" "$ROOT" cargo clippy --manifest-path "$ROOT/src-tauri/Cargo.toml" -- -D warnings
    [ $DO_TEST -eq 1 ]   && run "rust cargo test" "$ROOT" cargo test --lib --manifest-path "$ROOT/src-tauri/Cargo.toml"

    # Phase 2 completion criterion: a debug Tauri binary exists and isn't stale
    # relative to the Rust source. Cheap (no rebuild) so it runs on every pass.
    # Use --build-tauri to force a from-scratch rebuild.
    debugExe="$ROOT/src-tauri/target/debug/home-base.exe"
    if [ -f "$debugExe" ]; then
      # Find the newest source mtime under src-tauri/src and src-tauri/Cargo.toml.
      newestSrc=$(find "$ROOT/src-tauri/src" "$ROOT/src-tauri/Cargo.toml" "$ROOT/src-tauri/tauri.conf.json" \
        -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)
      exeMtime=$(stat -c '%Y' "$debugExe" 2>/dev/null || echo 0)
      if [ -n "$newestSrc" ] && [ "$(printf '%s' "$newestSrc" | cut -d. -f1)" -gt "$exeMtime" ]; then
        printf '[%sFAIL%s] %-22s %ss\n' "$C_RED" "$RST" "rust debug binary stale" "0"
        printf '    %s is older than a source file under src-tauri/.\n' "$debugExe"
        printf '    Re-run with --build-tauri to refresh.\n'
        FAIL=$((FAIL+1)); FAILED+=("rust debug binary stale")
      else
        printf '[%s OK %s] %-22s %ss\n' "$C_GRN" "$RST" "rust debug binary fresh" "0"
        PASS=$((PASS+1))
      fi
    else
      printf '[%sFAIL%s] %-22s %ss\n' "$C_RED" "$RST" "rust debug binary missing" "0"
      printf '    %s not found. Re-run with --build-tauri to produce it.\n' "$debugExe"
      FAIL=$((FAIL+1)); FAILED+=("rust debug binary missing")
    fi
  else skip "rust (cargo not found)"; fi
fi

if [ $DO_BUILD -eq 1 ]; then
  if want server && have bun; then run "server dist build" "$ROOT/server-jarvis" bun run build; fi
  if want ui     && have bun; then run "ui dist build"     "$ROOT/src-ui"        bun run build; fi
fi

if [ $DO_BUILD_TAURI -eq 1 ]; then
  if want rust && have cargo; then
    # `--no-bundle` skips the NSIS installer (slow, not needed for a debug gate);
    # `beforeBuildCommand` in tauri.conf.json still rebuilds server dist + UI.
    run "tauri debug build" "$ROOT" cargo tauri build --debug --no-bundle
  else skip "tauri debug build (cargo not found)"; fi
fi

echo "────────────────────────────────────"
if [ $FAIL -eq 0 ]; then
  printf '%s✓ all %d checks passed%s\n' "$C_GRN" "$PASS" "$RST"; exit 0
else
  printf '%s✗ %d failed%s (%d passed): %s\n' "$C_RED" "$FAIL" "$RST" "$PASS" "${FAILED[*]}"; exit 1
fi
