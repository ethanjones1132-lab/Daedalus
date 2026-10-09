#!/usr/bin/env bash
# Final lean-Laya acceptance (2026-10-09): once K2-Horizon is done (marker), label the calibration pool with the final
# lean worker (LAYA_INT8=1, rubric form only) and compare with the 2026-10-08 fp32 labels. CPU only; runs beside the
# roster's GPU generations. Touches logs/step1/laya-final-accept.done.
set -u
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
L=/c/qwen3-forge-stage/logs/step1
until [ -e "$L/k2.done" ]; do sleep 30; done
cd "$WT" || exit 1
rm -f "$L/laya3-calib-labels-w8v2.jsonl"
LAYA_INT8=1 TIER2B_DIR=docs/benchmarks/laya-calib USE_TF=0 /c/qwen3-forge-stage/venv-laya/Scripts/python.exe -W ignore \
  scripts/moe-bench/laya_partner.py label --v3 --forms rubric --runs docs/benchmarks/laya3/laya3-calib-nested.jsonl \
  --out "$L/laya3-calib-labels-w8v2.jsonl" > "$L/laya-w8v2-labels.out" 2>&1
/c/qwen3-forge-stage/venv/Scripts/python.exe scripts/moe-bench/laya_lean_eval.py accept \
  --fp32 docs/benchmarks/laya3/laya3-calib-labels.jsonl --lean "$L/laya3-calib-labels-w8v2.jsonl" \
  --trials docs/benchmarks/laya3/laya3-calib-nested.jsonl --calib docs/benchmarks/laya3/calib.json \
  --rule docs/benchmarks/laya3/rule.json --out "$L/laya-accept-final.json" > "$L/laya-accept-final.out" 2>&1
touch "$L/laya-final-accept.done"
