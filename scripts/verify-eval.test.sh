#!/usr/bin/env bash
# verify-eval.test.sh — isolated regression test for the eval-gate wiring in
# scripts/verify.sh.
#
# Proves that:
#   1. `--only server` runs the server typecheck and the deterministic eval gate
#      (server-jarvis `test:gate`, which runs src/eval/harness.ts),
#   2. a nonzero eval result makes verify exit nonzero,
#   3. later checks still run and aggregate after the eval failure, and
#   4. other `--only` selectors do not run the eval gate.
#
# Every case copies verify.sh into a disposable workspace and puts logging
# stubs for bun/bunx/python3/cargo ahead of the real tools. The live checkout is
# never executed and nothing is written outside the temp workspace.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_SRC="$SCRIPT_DIR/verify.sh"

if [ ! -f "$VERIFY_SRC" ]; then
  echo "verify-eval.test.sh: missing $VERIFY_SRC" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-eval-test.XXXXXX")" || {
  echo "verify-eval.test.sh: could not create a temp workspace" >&2
  exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
FAILED=()

ok()  { printf '[ OK ] %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '[FAIL] %s\n' "$1"; FAIL=$((FAIL + 1)); FAILED+=("$1"); }

check_contains() { # check_contains <label> <file> <literal>
  if grep -Fq -- "$3" "$2"; then ok "$1"; else bad "$1"; fi
}
check_absent() { # check_absent <label> <file> <literal>
  if grep -Fq -- "$3" "$2"; then bad "$1"; else ok "$1"; fi
}

write_stubs() { # write_stubs <case-dir>
  local bin="$1/home/.local/bin"

  # verify.sh prepends $HOME/.local/bin to PATH, so this directory wins even if
  # the host already has real bun/cargo/python3 installed.
  cat > "$bin/bun" <<'STUB'
#!/usr/bin/env bash
printf 'bun %s\n' "$*" >> "${STUB_CALL_LOG:?}"
# `test:gate` is the existing package script:
#   bun test src/eval/harness.test.ts && bun run src/eval/harness.ts
# Record the harness step only when the real package.json actually names it.
if [ "${1:-}" = "run" ] && [ "${2:-}" = "test:gate" ]; then
  if grep -Fq 'src/eval/harness.ts' package.json 2>/dev/null; then
    printf 'bun run src/eval/harness.ts\n' >> "${STUB_CALL_LOG:?}"
  fi
  if [ "${STUB_EVAL_FAIL:-0}" = "1" ]; then
    printf 'stub: eval regression gate failed (forced)\n' >&2
    exit 1
  fi
fi
exit 0
STUB

  cat > "$bin/bunx" <<'STUB'
#!/usr/bin/env bash
printf 'bunx %s\n' "$*" >> "${STUB_CALL_LOG:?}"
exit 0
STUB

  cat > "$bin/python3" <<'STUB'
#!/usr/bin/env bash
printf 'python3 %s\n' "$*" >> "${STUB_CALL_LOG:?}"
exit 0
STUB

  cat > "$bin/cargo" <<'STUB'
#!/usr/bin/env bash
printf 'cargo %s\n' "$*" >> "${STUB_CALL_LOG:?}"
exit 0
STUB

  chmod +x "$bin/bun" "$bin/bunx" "$bin/python3" "$bin/cargo"
}

new_case() { # new_case <name> — prints the disposable case root
  local dir="$WORK/$1"

  mkdir -p "$dir/scripts" "$dir/server-jarvis" "$dir/src-ui" \
    "$dir/src-tauri/src" "$dir/src-tauri/target/debug" \
    "$dir/home/.local/bin"

  cp "$VERIFY_SRC" "$dir/scripts/verify.sh"
  chmod +x "$dir/scripts/verify.sh"
  : > "$dir/scripts/claude_cli_proxy.py"
  # The stub uses the real package script to decide whether test:gate reaches
  # the harness; the file itself is never modified.
  cp "$REPO_ROOT/server-jarvis/package.json" "$dir/server-jarvis/package.json"

  # Satisfy the rust freshness probe without invoking a real toolchain: sources
  # are written first, then an artifact at least as new as all of them.
  printf 'fn main() {}\n' > "$dir/src-tauri/src/main.rs"
  printf '{}\n' > "$dir/src-tauri/Cargo.toml"
  printf '{}\n' > "$dir/src-tauri/tauri.conf.json"
  printf 'stub binary\n' > "$dir/src-tauri/target/debug/home-base.exe"

  write_stubs "$dir"
  printf '%s\n' "$dir"
}

run_verify() { # run_verify <case-dir> [verify args...]
  local dir="$1"; shift

  : > "$dir/calls.log"
  (
    cd "$dir" || exit 1
    export HOME="$dir/home"
    export PATH="$dir/home/.local/bin:$PATH"
    export STUB_CALL_LOG="$dir/calls.log"
    export STUB_EVAL_FAIL="${STUB_EVAL_FAIL:-0}"
    bash "$dir/scripts/verify.sh" "$@"
  ) > "$dir/output.log" 2>&1
}

case_server_wires_gate() {
  local dir rc
  dir="$(new_case server)"
  run_verify "$dir" --only server
  rc=$?

  if [ "$rc" -eq 0 ]; then
    ok "server selector passes when the gate passes"
  else
    bad "server selector passes when the gate passes (exit $rc)"
  fi
  check_contains "server selector keeps the existing build" "$dir/calls.log" "bun build"
  check_contains "server selector keeps the existing test" "$dir/calls.log" "bun test"
  check_contains "server selector runs typecheck" "$dir/calls.log" "bun run typecheck"
  check_contains "server selector runs test:gate" "$dir/calls.log" "bun run test:gate"
  check_contains "server selector reaches src/eval/harness.ts" "$dir/calls.log" "bun run src/eval/harness.ts"
}

case_other_selector_skips_gate() {
  local sel dir rc
  for sel in proxy ui rust; do
    dir="$(new_case "other-$sel")"
    run_verify "$dir" --only "$sel"
    rc=$?

    if [ "$rc" -eq 0 ]; then
      ok "--only $sel passes when the gate passes"
    else
      bad "--only $sel passes when the gate passes (exit $rc)"
    fi
    check_absent "--only $sel does not run test:gate" "$dir/calls.log" "test:gate"
    check_absent "--only $sel does not run the eval harness" "$dir/calls.log" "src/eval/harness.ts"
  done
}

case_eval_failure_propagates() {
  local dir rc
  dir="$(new_case eval-fail)"
  STUB_EVAL_FAIL=1
  run_verify "$dir" --only server
  rc=$?
  STUB_EVAL_FAIL=0

  if [ "$rc" -ne 0 ]; then
    ok "nonzero eval result fails the server selector"
  else
    bad "nonzero eval result fails the server selector"
  fi
  check_contains "server section reports the eval gate failure" "$dir/output.log" "server test:gate"
  check_contains "server section surfaces the gate output" "$dir/output.log" "eval regression gate failed"
  check_contains "server build still ran before the gate" "$dir/output.log" "server build"
}

case_later_checks_still_run() {
  local dir rc
  dir="$(new_case aggregate)"
  STUB_EVAL_FAIL=1
  run_verify "$dir"
  rc=$?
  STUB_EVAL_FAIL=0

  if [ "$rc" -ne 0 ]; then
    ok "full verify fails when the eval gate fails"
  else
    bad "full verify fails when the eval gate fails"
  fi
  check_contains "eval gate failure is reported" "$dir/output.log" "server test:gate"
  check_contains "later ui check still runs" "$dir/output.log" "ui tsc -b"
  check_contains "later rust check still runs" "$dir/output.log" "rust cargo check"
  check_contains "summary aggregates the eval failure" "$dir/output.log" "failed"
  check_contains "summary names the failing gate" "$dir/output.log" "server test:gate"
}

echo "── verify-eval.test @ $WORK ──"
case_server_wires_gate
case_other_selector_skips_gate
case_eval_failure_propagates
case_later_checks_still_run

echo "────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '✓ all %d checks passed\n' "$PASS"
  exit 0
else
  printf '✗ %d failed (%d passed): %s\n' "$FAIL" "$PASS" "${FAILED[*]}"
  exit 1
fi
