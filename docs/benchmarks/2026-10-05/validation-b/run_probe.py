"""Probe-then-fix on the fresh hidden-package validation set, Qwen3.6 keep96 then Gemma 26B
(TIER2B_DIR points the harness at validation-b)."""
import os
import subprocess
import sys

S = r"C:\qwen3-forge-stage"
MB = r"C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench"
env = {**os.environ, "TIER2B_DIR": S + r"\validation-b"}
code = 0
for model, base in (("qwen36keep96", "valb-qwen36keep96-single"), ("gemma26b", "valb-gemma26b-greedy")):
    code |= subprocess.run([S + r"\venv\Scripts\python.exe", MB + r"\probe_tier2b.py", "run", "--model", model,
                            "--out", S + rf"\logs\valb-probe-{model}-2026-10-05.jsonl",
                            "--baseline", S + rf"\logs\{base}-2026-10-05.jsonl"], env=env).returncode
sys.exit(code)
