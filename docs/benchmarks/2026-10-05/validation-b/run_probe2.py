"""Probe-then-fix v2 (a crashed probe gets one corrected retry; the fix prompt asks for the module file
and its own imports) on tier2b and on the fresh hidden-package set, for Qwen3.6 keep96 and Gemma 26B."""
import os
import subprocess
import sys

S = r"C:\qwen3-forge-stage"
MB = r"C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench"
L = S + r"\logs"
runs = [  # (model, task set dir or None for tier2b, out, baseline)
    ("qwen36keep96", None, rf"{L}\probe2-qwen36keep96-2026-10-05.jsonl", rf"{L}\tier2b-qwen36keep96-samp-base-2026-10-04.jsonl"),
    ("qwen36keep96", S + r"\validation-b", rf"{L}\valb-probe2-qwen36keep96-2026-10-05.jsonl", rf"{L}\valb-qwen36keep96-single-2026-10-05.jsonl"),
    ("gemma26b", S + r"\validation-b", rf"{L}\valb-probe2-gemma26b-2026-10-05.jsonl", rf"{L}\valb-gemma26b-greedy-2026-10-05.jsonl"),
    ("gemma26b", None, rf"{L}\probe2-gemma26b-2026-10-05.jsonl", rf"{L}\tier2b-gemma26b-samp-greedy-2026-10-04.jsonl"),
]
code = 0
for model, tdir, out, base in runs:
    env = {**os.environ, **({"TIER2B_DIR": tdir} if tdir else {})}
    env.pop("TIER2B_DIR", None) if not tdir else None
    code |= subprocess.run([S + r"\venv\Scripts\python.exe", MB + r"\probe_tier2b.py", "run", "--model", model,
                            "--prompt-v", "2", "--out", out, "--baseline", base], env=env).returncode
sys.exit(code)
