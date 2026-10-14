#!/usr/bin/env bash
# Run the Ecosystem Lab checks (dev set, with screenshots, then the exploratory assembled pass) for models whose builds
# exist but whose checks do not. The params path must be absolute: check() runs node from scripts/oneshot.
# usage: check_roster.sh MODEL [MODEL ...]
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
RUNS=/c/qwen3-forge-stage/logs/oneshot/runs
P="$(cygpath -m "$WT")/docs/benchmarks/oneshot/ecosystem-lab/params-dev.json"
cd "$WT" || exit 1
for m in "$@"; do
  n=$(ls "$RUNS/$m"/*/response.md 2>/dev/null | wc -l)
  c=$(ls "$RUNS/$m"/*/checks-dev.json 2>/dev/null | wc -l)
  a=$(ls "$RUNS/$m"/*/checks-dev-assembled.json 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || { echo "$m: no builds"; continue; }
  [ "$c" -ge "$n" ] || "$PY" scripts/oneshot/oneshot_bench.py check --runs "$RUNS" --params "$P" --set dev --shots --only "$m"
  [ "$a" -ge "$n" ] || "$PY" scripts/oneshot/oneshot_bench.py check --runs "$RUNS" --params "$P" --set dev --assembled --only "$m"
done
